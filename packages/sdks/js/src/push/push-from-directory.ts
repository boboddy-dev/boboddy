import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPipelineDefinitionsClient,
  type PipelineDefinitionSpec,
  type StepDefinitionRef,
} from "../definitions/pipelines";
import {
  createStepDefinitionsClient,
  type StepDefinitionSpec,
} from "../definitions/steps";

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
 * Imports every `.ts`/`.js` file in `dir` (except the push script itself),
 * collects all pipeline and step definitions, then upserts them via the
 * strongly-typed SDK clients.
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

  const sourceFiles = readdirSync(absDir).filter(
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".js")) && !PUSH_SCRIPT_NAMES.has(f),
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

  if (pipelineSpecs.length === 0) {
    return { pushedSteps: stepMap.size, pushedPipelines: 0 };
  }

  const pipelinesClient = createPipelineDefinitionsClient(opts.baseUrl);

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

  return { pushedSteps: stepMap.size, pushedPipelines: pipelineSpecs.length };
}
