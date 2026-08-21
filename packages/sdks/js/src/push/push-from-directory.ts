import {
  createPipelineDefinitionsClient,
  type StepDefinitionRef,
} from "../definitions/pipelines";
import {
  DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
  serializeDefaultPipelineAssignment,
  type DefaultPipelineAssignmentSpec,
} from "../definitions/pipelines/define-default-pipeline-assignment";
import { createStepDefinitionsClient } from "../definitions/steps";
import { assertValidDefinitionSpecs } from "../definitions/validation";
import { createClient } from "../generated/client";
import { Projects } from "../generated/sdk.gen";
import { collectDefinitionsFromDirectory } from "./collect-definitions";

export interface PushFromDirectoryOptions {
  baseUrl: string;
  projectId: string;
  accessToken: string;
  /** Override the logger; defaults to console.log. */
  log?: (message: string) => void;
}

export interface PushFromDirectoryResult {
  pushedSteps: number;
  pushedPipelines: number;
  /** true if the default pipeline assignment was synced to the server. */
  syncedDefaultPipelineAssignment: boolean;
}

/**
 * Imports every `.ts`/`.js` file in `dir` (except the push script itself and
 * `default-pipeline-assignment.ts`), collects all pipeline and step
 * definitions, validates them, then upserts them via the strongly-typed SDK
 * clients.
 *
 * If `default-pipeline-assignment.ts` is present, it is imported separately
 * after pipelines are pushed, and the project default pipeline assignment is
 * updated on the server.
 *
 * Collection is `collectDefinitionsFromDirectory` (offline, no token) and
 * validation is `validateDefinitionSpecs` (pure). Both run before the first
 * mutating request, so a batch with a dead signal `sourcePath`, a dangling
 * route target, or a backwards signal binding fails without half-pushing.
 *
 * Designed to run on the user's native runtime (bun, node-with-tsx, deno),
 * NOT inside a `bun --compile`'d binary — that runtime can't resolve scoped
 * package `exports` field remappings from external user files.
 */
export async function pushFromDirectory(
  dir: string,
  opts: PushFromDirectoryOptions,
): Promise<PushFromDirectoryResult> {
  const log =
    opts.log ??
    ((msg: string) => {
      console.warn(msg);
    });
  const headers = { Authorization: `Bearer ${opts.accessToken}` };

  const collected = await collectDefinitionsFromDirectory(dir);
  const { pipelines, steps } = collected;

  log(
    `Found ${String(pipelines.length)} pipeline(s) and ${String(steps.length)} step(s).`,
  );

  const stepsClient = createStepDefinitionsClient(opts.baseUrl);
  const pipelinesClient = createPipelineDefinitionsClient(opts.baseUrl);

  // Route targets may already live on the server, so the known-key set needs
  // one read before validation can run. Nothing has been written yet.
  const serverPipelineKeys =
    pipelines.length > 0
      ? (
          await pipelinesClient.listByProjectId(opts.projectId, { headers })
        ).map((pipeline) => pipeline.key)
      : [];

  assertValidDefinitionSpecs(
    { pipelines, steps },
    { knownPipelineKeys: serverPipelineKeys },
  );

  // Upsert steps first so the server knows about them by the time we push
  // pipelines (which reference step IDs).
  for (const spec of steps) {
    await stepsClient.upsertFromSpec(opts.projectId, spec, { headers });
    log(`✓ step ${spec.key} v${String(spec.version)} → upserted`);
  }

  if (pipelines.length > 0) {
    const serverSteps = await stepsClient.listByProjectId(opts.projectId, {
      headers,
    });
    const stepDefs: StepDefinitionRef[] = serverSteps.map((s) => ({
      id: s.id,
      key: s.key,
      version: s.version,
    }));

    for (const spec of pipelines) {
      await pipelinesClient.upsertFromSpec(opts.projectId, spec, stepDefs, {
        headers,
      });
      log(`✓ pipeline ${spec.key} v${String(spec.version)} → upserted`);
    }
  }

  const syncedDefaultPipelineAssignment = collected.defaultPipelineAssignment
    ? await syncDefaultPipelineAssignment(
        collected.defaultPipelineAssignment,
        opts,
        headers,
        pipelinesClient,
        log,
      )
    : false;

  return {
    pushedSteps: steps.length,
    pushedPipelines: pipelines.length,
    syncedDefaultPipelineAssignment,
  };
}

async function syncDefaultPipelineAssignment(
  spec: DefaultPipelineAssignmentSpec,
  opts: PushFromDirectoryOptions,
  headers: { Authorization: string },
  pipelinesClient: ReturnType<typeof createPipelineDefinitionsClient>,
  log: (msg: string) => void,
): Promise<boolean> {
  const serialized = serializeDefaultPipelineAssignment(spec);

  // Fetch all server pipelines to resolve pipeline key → pipelineDefinitionId
  const serverPipelines = await pipelinesClient.listByProjectId(
    opts.projectId,
    {
      headers,
    },
  );

  // Build key → id map from all referenced pipeline keys (assign outcomes)
  const pipelineKeyToId = new Map<string, string>(
    (serverPipelines as Array<{ key: string; id: string }>).map((p) => [
      p.key,
      p.id,
    ]),
  );

  // Collect all pipeline keys referenced in the spec (assign outcomes)
  const referencedKeys = new Set<string>();
  referencedKeys.add(serialized.pipelineDefinitionKey);
  for (const rule of serialized.rulesJson.rules) {
    if (
      rule.event.type === "assign" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      referencedKeys.add(rule.event.params["pipelineKey"]);
    }
  }

  // Validate all referenced pipeline keys exist on the server
  for (const key of referencedKeys) {
    if (!pipelineKeyToId.has(key)) {
      throw new Error(
        `${DEFAULT_PIPELINE_ASSIGNMENT_FILENAME} references pipeline "${key}", ` +
          `but no pipeline with that key was found on the server. ` +
          `Push the pipeline first with \`boboddy pipelines push\`.`,
      );
    }
  }

  // Resolve the primary pipelineDefinitionId
  const pipelineDefinitionId = pipelineKeyToId.get(
    serialized.pipelineDefinitionKey,
  );
  if (!pipelineDefinitionId) {
    throw new Error(
      `Pipeline key "${serialized.pipelineDefinitionKey}" was not found on the server.`,
    );
  }

  // Rewrite assign event params: replace pipelineKey → pipelineDefinitionId
  const resolvedRules = serialized.rulesJson.rules.map((rule) => {
    if (
      rule.event.type === "assign" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      const pKey = rule.event.params["pipelineKey"];
      const pId = pipelineKeyToId.get(pKey);
      if (!pId) {
        throw new Error(
          `${DEFAULT_PIPELINE_ASSIGNMENT_FILENAME} assign() references pipeline "${pKey}" ` +
            `which was not found on the server.`,
        );
      }
      return {
        ...rule,
        event: {
          ...rule.event,
          params: {
            ...rule.event.params,
            pipelineDefinitionId: pId,
          },
        },
      };
    }
    return rule;
  });

  // Call the server API
  const projectsClient = new Projects({
    client: createClient({ baseUrl: opts.baseUrl }),
  });

  const result = await projectsClient.updateProjectDefaultPipelineAssignment({
    path: { projectId: opts.projectId },
    body: {
      defaultPipelineAssignment: {
        pipelineDefinitionId,
        rulesJson: { rules: resolvedRules },
        defaultEventType: serialized.defaultEventType,
        defaultEventParamsJson: serialized.defaultEventParamsJson,
        allowedEventTypes: serialized.allowedEventTypes,
      },
    },
    headers,
  });

  if (result.error) {
    throw new Error(
      `Failed to update project default pipeline assignment: ${JSON.stringify(result.error)}`,
    );
  }

  log(
    `✓ default pipeline assignment → synced (primary pipeline: ${serialized.pipelineDefinitionKey})`,
  );
  return true;
}
