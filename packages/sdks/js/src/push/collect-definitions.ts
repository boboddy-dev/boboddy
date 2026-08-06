// The offline half of `pushFromDirectory`: turn a directory of definition files
// into the specs they export.
//
// Deliberately takes no token and makes no network call, so the same collection
// a real push performs can be exercised — and validated — with no server. The
// upsert half lives in `push-from-directory.ts`.

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PipelineDefinitionSpec } from "../definitions/pipelines";
import {
  DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
  isDefaultPipelineAssignmentSpec,
  type DefaultPipelineAssignmentSpec,
} from "../definitions/pipelines/define-default-pipeline-assignment";
import type { StepDefinitionSpec } from "../definitions/steps";

/** Files that drive a push rather than declaring definitions. */
const PUSH_SCRIPT_NAMES = new Set(["push.ts", "push.mjs", "push.js"]);

export type CollectedDefinitions = {
  readonly pipelines: readonly PipelineDefinitionSpec[];
  /** Deduped by `key@vN`; named exports take precedence over embedded steps. */
  readonly steps: readonly StepDefinitionSpec[];
  /** Present only when `default-pipeline-assignment.ts` exists in the directory. */
  readonly defaultPipelineAssignment: DefaultPipelineAssignmentSpec | null;
};

// eslint-disable-next-line local/no-unknown-parameter-type
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
  // eslint-disable-next-line local/no-unknown-parameter-type
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

async function importModule(path: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

/**
 * Imports every `.ts`/`.js` file in `dir` (except the push script itself and
 * `default-pipeline-assignment.ts`) and collects the pipeline and step
 * definitions they export. The assignment file, when present, is imported and
 * validated too but returned separately — syncing it needs the server.
 *
 * Designed to run on the user's native runtime (bun, node-with-tsx, deno), NOT
 * inside a `bun --compile`'d binary — that runtime can't resolve scoped package
 * `exports` field remappings from external user files.
 */
export async function collectDefinitionsFromDirectory(
  dir: string,
): Promise<CollectedDefinitions> {
  const absDir = resolve(dir);
  const allFiles = readdirSync(absDir).filter(
    (file) => file.endsWith(".ts") || file.endsWith(".js"),
  );

  const sourceFiles = allFiles.filter(
    (file) =>
      !PUSH_SCRIPT_NAMES.has(file) &&
      file !== DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
  );

  const pipelines: PipelineDefinitionSpec[] = [];
  const stepMap = new Map<string, StepDefinitionSpec>();

  for (const file of sourceFiles) {
    const mod = await importModule(join(absDir, file));

    for (const [exportName, value] of Object.entries(mod)) {
      if (exportName === "default") {
        if (isPipelineDefinitionSpec(value)) pipelines.push(value);
        continue;
      }
      if (isStepDefinitionSpec(value)) {
        stepMap.set(`${value.key}@v${String(value.version)}`, value);
      }
    }
  }

  // Pick up steps embedded in pipelines (steps not explicitly exported).
  // Named exports take precedence.
  for (const spec of pipelines) {
    for (const embedded of spec._stepDefinitions ?? []) {
      const key = `${embedded.key}@v${String(embedded.version)}`;
      if (!stepMap.has(key)) stepMap.set(key, embedded);
    }
  }

  return {
    pipelines,
    steps: [...stepMap.values()],
    defaultPipelineAssignment: await collectDefaultPipelineAssignment(absDir),
  };
}

async function collectDefaultPipelineAssignment(
  absDir: string,
): Promise<DefaultPipelineAssignmentSpec | null> {
  const path = join(absDir, DEFAULT_PIPELINE_ASSIGNMENT_FILENAME);
  if (!existsSync(path)) return null;

  const mod = await importModule(path);
  const spec = mod["default"];
  if (!isDefaultPipelineAssignmentSpec(spec)) {
    throw new Error(
      `${DEFAULT_PIPELINE_ASSIGNMENT_FILENAME} must have a default export produced by ` +
        `defaultPipelineAssignment(({ assign, skip, ... }) => ({ default: ..., rules: [...] })). ` +
        `Got: ${typeof spec}`,
    );
  }
  return spec;
}
