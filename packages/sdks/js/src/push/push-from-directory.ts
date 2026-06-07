import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPipelineDefinitionsClient,
  type PipelineDefinitionSpec,
  type StepDefinitionRef,
} from "../definitions/pipelines";
import {
  DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
  isDefaultPipelineAssignmentSpec,
  serializeDefaultPipelineAssignment,
  type DefaultPipelineAssignmentSpec,
} from "../definitions/pipelines/define-default-pipeline-assignment";
import {
  createStepDefinitionsClient,
  type StepDefinitionSpec,
} from "../definitions/steps";
import { createClient } from "../generated/client";
import { Projects } from "../generated/sdk.gen";

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

function isStepDefinitionSpec(value: unknown): value is StepDefinitionSpec {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["key"] === "string" &&
    typeof obj["name"] === "string" &&
    typeof obj["version"] === "number" &&
    obj["kind"] === "user_defined"
  );
}

function isPipelineDefinitionSpec(
  value: unknown,
): value is PipelineDefinitionSpec {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["key"] === "string" &&
    typeof obj["name"] === "string" &&
    typeof obj["version"] === "number" &&
    Array.isArray(obj["steps"])
  );
}

function extractRoutePipelineKeys(policy: {
  defaultEventType: string;
  defaultEventParamsJson: Record<string, unknown> | null;
  rulesJson: {
    rules: Array<{ event: { type: string; params?: Record<string, unknown> } }>;
  };
}): string[] {
  const keys: string[] = [];
  if (
    policy.defaultEventType === "route" &&
    typeof policy.defaultEventParamsJson?.["pipelineKey"] === "string"
  ) {
    keys.push(policy.defaultEventParamsJson["pipelineKey"] as string);
  }
  for (const rule of policy.rulesJson.rules) {
    if (
      rule.event.type === "route" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      keys.push(rule.event.params["pipelineKey"] as string);
    }
  }
  return keys;
}

const PUSH_SCRIPT_NAMES = new Set(["push.ts", "push.mjs", "push.js"]);

/**
 * Imports every `.ts`/`.js` file in `dir` (except the push script itself and
 * `default-pipeline-assignment.ts`), collects all pipeline and step
 * definitions, then upserts them via the strongly-typed SDK clients.
 *
 * If `default-pipeline-assignment.ts` is present, it is imported separately
 * after pipelines are pushed, and the project default pipeline assignment is
 * updated on the server.
 *
 * Designed to run on the user's native runtime (bun, node-with-tsx, deno),
 * NOT inside a `bun --compile`'d binary — that runtime can't resolve scoped
 * package `exports` field remappings from external user files.
 */
export async function pushFromDirectory(
  dir: string,
  opts: PushFromDirectoryOptions,
): Promise<PushFromDirectoryResult> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const headers = { Authorization: `Bearer ${opts.accessToken}` };
  const absDir = resolve(dir);

  const allFiles = readdirSync(absDir).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js"),
  );

  // Separate the special assignment file from normal pipeline definition files
  const hasAssignmentFile = existsSync(
    join(absDir, DEFAULT_PIPELINE_ASSIGNMENT_FILENAME),
  );

  const sourceFiles = allFiles.filter(
    (f) =>
      !PUSH_SCRIPT_NAMES.has(f) && f !== DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
  );

  const pipelineSpecs: PipelineDefinitionSpec[] = [];
  const stepMap = new Map<string, StepDefinitionSpec>();

  for (const file of sourceFiles) {
    const absPath = join(absDir, file);
    const mod = (await import(pathToFileURL(absPath).href)) as Record<
      string,
      unknown
    >;

    for (const [exportName, value] of Object.entries(mod)) {
      if (exportName === "default") {
        if (isPipelineDefinitionSpec(value)) {
          pipelineSpecs.push(value);
        }
        continue;
      }
      if (isStepDefinitionSpec(value)) {
        stepMap.set(`${value.key}@v${String(value.version)}`, value);
      }
    }
  }

  // Pick up steps embedded in pipelines (steps not explicitly exported).
  // Named exports take precedence.
  for (const spec of pipelineSpecs) {
    for (const embedded of spec._stepDefinitions ?? []) {
      const key = `${embedded.key}@v${String(embedded.version)}`;
      if (!stepMap.has(key)) {
        stepMap.set(key, embedded);
      }
    }
  }

  log(`Found ${String(pipelineSpecs.length)} pipeline(s) and ${String(stepMap.size)} step(s).`);

  // Upsert steps first so the server knows about them by the time we push
  // pipelines (which reference step IDs).
  const stepsClient = createStepDefinitionsClient(opts.baseUrl);
  for (const spec of stepMap.values()) {
    await stepsClient.upsertFromSpec(opts.projectId, spec, { headers });
    log(`✓ step ${spec.key} v${String(spec.version)} → upserted`);
  }

  const pipelinesClient = createPipelineDefinitionsClient(opts.baseUrl);

  let pushedPipelinesCount = 0;

  if (pipelineSpecs.length > 0) {
    // Fetch existing pipelines once for route-key validation, then list step
    // defs to resolve `stepDefinitionId` for each pipeline step.
    const existingPipelines = await pipelinesClient.listByProjectId(
      opts.projectId,
      { headers },
    );
    const knownPipelineKeys = new Set<string>([
      ...pipelineSpecs.map((s) => s.key),
      ...existingPipelines.map((p) => p.key),
    ]);

    for (const spec of pipelineSpecs) {
      for (const step of spec.steps) {
        const routeKeys = extractRoutePipelineKeys(step.advancementPolicyDefinition);
        for (const routeKey of routeKeys) {
          if (!knownPipelineKeys.has(routeKey)) {
            throw new Error(
              `Pipeline "${spec.key}" step "${step.stepKey}" routes to pipeline "${routeKey}", ` +
                `but no pipeline with that key was found on the server or in the current push batch. ` +
                `Push the target pipeline first.`,
            );
          }
        }
      }
    }

    const serverSteps = await stepsClient.listByProjectId(opts.projectId, {
      headers,
    });
    const stepDefs: StepDefinitionRef[] = (serverSteps ?? []).map((s) => ({
      id: s.id,
      key: s.key,
      version: s.version,
    }));

    for (const spec of pipelineSpecs) {
      await pipelinesClient.upsertFromSpec(opts.projectId, spec, stepDefs, {
        headers,
      });
      log(`✓ pipeline ${spec.key} v${String(spec.version)} → upserted`);
    }

    pushedPipelinesCount = pipelineSpecs.length;
  }

  // Handle default pipeline assignment file
  let syncedDefaultPipelineAssignment = false;

  if (hasAssignmentFile) {
    const assignmentFilePath = join(
      absDir,
      DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
    );
    const assignmentMod = (await import(
      pathToFileURL(assignmentFilePath).href
    )) as Record<string, unknown>;

    const assignmentSpec = assignmentMod["default"];
    if (!isDefaultPipelineAssignmentSpec(assignmentSpec)) {
      throw new Error(
        `${DEFAULT_PIPELINE_ASSIGNMENT_FILENAME} must have a default export produced by ` +
          `defaultPipelineAssignment(({ assign, skip, ... }) => ({ default: ..., rules: [...] })). ` +
          `Got: ${typeof assignmentSpec}`,
      );
    }

    syncedDefaultPipelineAssignment = await syncDefaultPipelineAssignment(
      assignmentSpec,
      opts,
      headers,
      pipelinesClient,
      log,
    );
  }

  return {
    pushedSteps: stepMap.size,
    pushedPipelines: pushedPipelinesCount,
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

  // Fetch all server pipelines to resolve pipeline key → linearPipelineDefinitionId
  const serverPipelines = await pipelinesClient.listByProjectId(opts.projectId, {
    headers,
  });

  // Build key → id map from all referenced pipeline keys (assign outcomes)
  const pipelineKeyToId = new Map<string, string>(
    (serverPipelines as Array<{ key: string; id: string }>).map((p) => [
      p.key,
      p.id,
    ]),
  );

  // Collect all pipeline keys referenced in the spec (assign outcomes)
  const referencedKeys = new Set<string>();
  referencedKeys.add(serialized.linearPipelineDefinitionKey);
  for (const rule of serialized.rulesJson.rules) {
    if (
      rule.event.type === "assign" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      referencedKeys.add(rule.event.params["pipelineKey"] as string);
    }
  }

  // Validate all referenced pipeline keys exist on the server
  for (const key of referencedKeys) {
    if (!pipelineKeyToId.has(key)) {
      throw new Error(
        `default-pipeline-assignment.ts references pipeline "${key}", ` +
          `but no pipeline with that key was found on the server. ` +
          `Push the pipeline first with \`boboddy pipelines push\`.`,
      );
    }
  }

  // Resolve the primary linearPipelineDefinitionId
  const linearPipelineDefinitionId = pipelineKeyToId.get(
    serialized.linearPipelineDefinitionKey,
  )!;

  // Rewrite assign event params: replace pipelineKey → pipelineDefinitionId
  const resolvedRules = serialized.rulesJson.rules.map((rule) => {
    if (
      rule.event.type === "assign" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      const pKey = rule.event.params["pipelineKey"] as string;
      const pId = pipelineKeyToId.get(pKey);
      if (!pId) {
        throw new Error(
          `default-pipeline-assignment.ts assign() references pipeline "${pKey}" ` +
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
        linearPipelineDefinitionId,
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

  log(`✓ default pipeline assignment → synced (primary pipeline: ${serialized.linearPipelineDefinitionKey})`);
  return true;
}
