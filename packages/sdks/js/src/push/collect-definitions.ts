// The offline half of `pushFromDirectory`: turn a directory of definition files
// into the specs they export.
//
// Deliberately takes no token and makes no network call, so the same collection
// a real push performs can be exercised — and validated — with no server. The
// upsert half lives in `push-from-directory.ts`.

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PipelineDefinitionSpec } from "../definitions/pipelines";
import {
  DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
  isDefaultPipelineAssignmentSpec,
  type DefaultPipelineAssignmentSpec,
} from "../definitions/pipelines/define-default-pipeline-assignment";
import type { StepDefinitionSpec } from "../definitions/steps";

/**
 * Files that drive a push or the pipeline-builder studio rather than
 * declaring definitions themselves.
 */
const INTERNAL_SCRIPT_NAMES = new Set([
  "push.ts",
  "push.mjs",
  "push.js",
  ".boboddy-studio-collect.mjs",
]);

/**
 * The fixed, repo-root-relative directory `boboddy pipelines init` scaffolds
 * and `boboddy pipelines push`/`studio` always run from. `resolveCodeStepEntrypoint`
 * uses this to record a `kind: "code"` step's `sourceFile` relative to the repo
 * root (what the worker's `execute-code-step.ts` expects when it joins
 * `sourceFile` onto the checked-out workspace root), regardless of what the
 * collecting process's own `cwd` happens to be.
 *
 * Duplicated nowhere else — `@boboddy/worker`'s own `PIPELINE_BUILDER_DIR`
 * imports this one, so there's a single source of truth.
 */
export const PIPELINE_BUILDER_DIR = ".boboddy/pipeline-builder";

export type CollectedDefinitions = {
  readonly pipelines: readonly PipelineDefinitionSpec[];
  /** Deduped by `key@vN`; named exports take precedence over embedded steps. */
  readonly steps: readonly StepDefinitionSpec[];
  /** Present only when `default-pipeline-assignment.ts` exists in the directory. */
  readonly defaultPipelineAssignment: DefaultPipelineAssignmentSpec | null;
};

/**
 * One source file that failed to produce a pipeline —
 * `collectDefinitionsFromDirectoryTolerant`'s per-file counterpart to a
 * `collectDefinitionsFromDirectory` throw. `key` is a best-effort
 * identifier: the file's own basename (no extension), since a failure can
 * happen before `definePipeline()` ever runs and assigns the pipeline its
 * real `key`.
 */
export type BrokenPipeline = {
  readonly key: string;
  readonly message: string;
};

export type TolerantCollectedDefinitions = CollectedDefinitions & {
  readonly brokenPipelines: readonly BrokenPipeline[];
};

// eslint-disable-next-line local/no-unknown-parameter-type
function isStepDefinitionSpec(value: unknown): value is StepDefinitionSpec {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["key"] === "string" &&
    typeof obj["name"] === "string" &&
    typeof obj["version"] === "number" &&
    (obj["kind"] === "user_defined" || obj["kind"] === "code")
  );
}

/**
 * For a `kind === "code"` spec: finds whichever export of `mod` `===
 * spec.entrypoint.fn` by reference identity, combines it with the module's
 * own path — recorded relative to the repo root as
 * `PIPELINE_BUILDER_DIR/<file>`, since `absDir` (the directory being
 * collected) is always `PIPELINE_BUILDER_DIR` itself — into `entrypointJson`,
 * and strips the live `fn` reference (it can never be serialized into the
 * push request). Every other kind passes through unchanged.
 *
 * Deliberately does *not* use `process.cwd()`: `boboddy pipelines push` and
 * `studio` both spawn their collecting subprocess with `cwd` already set to
 * `PIPELINE_BUILDER_DIR` (so the subprocess's own runtime/lockfile detection
 * resolves correctly), which previously made `relative(process.cwd(), ...)`
 * collapse to a bare filename with no `PIPELINE_BUILDER_DIR` prefix — the
 * worker then joined that bare filename onto the workspace root and looked
 * in the wrong place (`ERR_MODULE_NOT_FOUND`). Anchoring on `absDir` instead
 * is correct regardless of the calling process's cwd.
 */
function resolveCodeStepEntrypoint(
  spec: StepDefinitionSpec,
  mod: Record<string, unknown>,
  absoluteFilePath: string,
  absDir: string,
): StepDefinitionSpec {
  if (spec.kind !== "code") return spec;

  const fn = spec.entrypoint?.fn;
  if (!fn) {
    throw new Error(
      `Code step "${spec.key}" (kind: "code") has no entrypoint.fn to resolve. ` +
        `Build it with codeStep({ fn, ... }) from "@boboddy/sdk/definitions/steps".`,
    );
  }

  const exportName = Object.entries(mod).find(
    ([, exportedValue]) => exportedValue === fn,
  )?.[0];
  if (!exportName) {
    throw new Error(
      `Code step "${spec.key}"'s fn is not a named export of ${absoluteFilePath}. ` +
        `codeStep({ fn }) requires fn to be exported by name from the same module ` +
        `so its entrypoint can be resolved to a portable {sourceFile, exportName} pair.`,
    );
  }

  const resolved: StepDefinitionSpec = { ...spec };
  delete resolved.entrypoint;
  resolved.entrypointJson = {
    sourceFile: join(PIPELINE_BUILDER_DIR, relative(absDir, absoluteFilePath)),
    exportName,
  };
  return resolved;
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
    Array.isArray(obj["nodeDefinitions"])
  );
}

async function importModule(path: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

/** `.ts`/`.js` files in `dir` that declare definitions — excludes internal scripts and `default-pipeline-assignment.ts`. */
function listSourceFiles(absDir: string): string[] {
  const allFiles = readdirSync(absDir).filter(
    (file) => file.endsWith(".ts") || file.endsWith(".js"),
  );
  return allFiles.filter(
    (file) =>
      !INTERNAL_SCRIPT_NAMES.has(file) &&
      file !== DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
  );
}

/** Strips a source file's extension for use as a best-effort display key. */
function fileNameWithoutExtension(file: string): string {
  return file.replace(/\.(ts|js)$/, "");
}

/**
 * Imports one source file and folds whatever it exports into `pipelines`/
 * `stepMap` — the per-file body shared by both `collectDefinitionsFromDirectory`
 * (which lets a throw here propagate straight out) and
 * `collectDefinitionsFromDirectoryTolerant` (which catches it per file).
 */
async function collectFile(
  absoluteFilePath: string,
  absDir: string,
  pipelines: PipelineDefinitionSpec[],
  stepMap: Map<string, StepDefinitionSpec>,
): Promise<void> {
  const mod = await importModule(absoluteFilePath);

  for (const [exportName, value] of Object.entries(mod)) {
    if (exportName === "default") {
      if (isPipelineDefinitionSpec(value)) pipelines.push(value);
      continue;
    }
    if (isStepDefinitionSpec(value)) {
      const resolved = resolveCodeStepEntrypoint(
        value,
        mod,
        absoluteFilePath,
        absDir,
      );
      stepMap.set(`${resolved.key}@v${String(resolved.version)}`, resolved);
    }
  }
}

/**
 * Pick up steps embedded in pipelines (steps not explicitly exported). Named
 * exports take precedence — an embedded `kind: "code"` step whose `fn` was
 * already resolved via a direct export is skipped here. Throws (naming the
 * owning pipeline) when an embedded `kind: "code"` step was never exported by
 * name, since its entrypoint can't be resolved without one.
 */
function foldEmbeddedSteps(
  dir: string,
  spec: PipelineDefinitionSpec,
  stepMap: Map<string, StepDefinitionSpec>,
): void {
  for (const embedded of spec._stepDefinitions ?? []) {
    const key = `${embedded.key}@v${String(embedded.version)}`;
    if (stepMap.has(key)) continue;
    if (embedded.kind === "code") {
      throw new Error(
        `Code step "${embedded.key}" is only referenced inside a pipeline and is not ` +
          `exported by name from any file in "${dir}". codeStep({ fn }) requires fn to be ` +
          `a named export so its entrypoint can be resolved — export the step itself, e.g. ` +
          `\`export const ${embedded.key} = codeStep({ ... })\`.`,
      );
    }
    stepMap.set(key, embedded);
  }
}

/**
 * Imports every `.ts`/`.js` file in `dir` (except the push script itself and
 * `default-pipeline-assignment.ts`) and collects the pipeline and step
 * definitions they export. The assignment file, when present, is imported and
 * validated too but returned separately — syncing it needs the server.
 *
 * Designed to run on the user's native runtime (bun, node-with-tsx, deno), NOT
 * inside a `bun --compile`'d binary — that runtime can't resolve scoped package
 * `exports` field remappings from external user files. `boboddy pipelines
 * studio` works around this for its own compiled binary by never calling this
 * function in-process: `collectDefinitionsViaSubprocess` (in
 * `packages/worker/src/pipelines/pipeline-studio/infra/collect-definitions-via-subprocess.ts`)
 * spawns a real bun/tsx/deno subprocess that calls this exact function from
 * outside the compiled binary. Calling it directly, in-process, from inside a
 * compiled binary is still unsupported.
 *
 * Throws on the first bad file — a syntax error, a `definePipeline()`-time
 * validation failure, an unresolvable `codeStep` entrypoint — aborting the
 * whole collection. That's the right behavior for `boboddy pipelines push`
 * (this function's only real caller besides its own tests): pushing a
 * partially-collected directory would be worse than refusing to push at all.
 * `boboddy pipelines studio` wants the opposite trade-off — see
 * `collectDefinitionsFromDirectoryTolerant` below.
 */
export async function collectDefinitionsFromDirectory(
  dir: string,
): Promise<CollectedDefinitions> {
  const absDir = resolve(dir);
  const sourceFiles = listSourceFiles(absDir);

  const pipelines: PipelineDefinitionSpec[] = [];
  const stepMap = new Map<string, StepDefinitionSpec>();

  for (const file of sourceFiles) {
    await collectFile(join(absDir, file), absDir, pipelines, stepMap);
  }

  for (const spec of pipelines) {
    foldEmbeddedSteps(dir, spec, stepMap);
  }

  return {
    pipelines,
    steps: [...stepMap.values()],
    defaultPipelineAssignment: await collectDefaultPipelineAssignment(absDir),
  };
}

/**
 * `collectDefinitionsFromDirectory`'s tolerant sibling, built for `boboddy
 * pipelines studio`: one file failing to import or compile (a syntax error,
 * an `assertTargetExists`-style `definePipeline()` throw, an unresolvable
 * `codeStep` entrypoint, ...) is recorded as a `BrokenPipeline` entry instead
 * of aborting collection — every *other* file's pipeline still comes back
 * usable, so one bad edit in the builder directory doesn't blank the whole
 * designer (see `compute-studio-snapshot.ts`).
 */
export async function collectDefinitionsFromDirectoryTolerant(
  dir: string,
): Promise<TolerantCollectedDefinitions> {
  const absDir = resolve(dir);
  const sourceFiles = listSourceFiles(absDir);

  const pipelines: PipelineDefinitionSpec[] = [];
  const stepMap = new Map<string, StepDefinitionSpec>();
  const brokenPipelines: BrokenPipeline[] = [];

  for (const file of sourceFiles) {
    try {
      await collectFile(join(absDir, file), absDir, pipelines, stepMap);
    } catch (error) {
      brokenPipelines.push({
        key: fileNameWithoutExtension(file),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A pipeline that imported fine can still turn out broken here, if one of
  // its embedded (never-exported) code steps can't be resolved — pulled out
  // of `pipelines` and reported the same way as an import-time failure.
  const okPipelines: PipelineDefinitionSpec[] = [];
  for (const spec of pipelines) {
    try {
      foldEmbeddedSteps(dir, spec, stepMap);
      okPipelines.push(spec);
    } catch (error) {
      brokenPipelines.push({
        key: spec.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let defaultPipelineAssignment: DefaultPipelineAssignmentSpec | null = null;
  try {
    defaultPipelineAssignment = await collectDefaultPipelineAssignment(absDir);
  } catch (error) {
    brokenPipelines.push({
      key: fileNameWithoutExtension(DEFAULT_PIPELINE_ASSIGNMENT_FILENAME),
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    pipelines: okPipelines,
    steps: [...stepMap.values()],
    defaultPipelineAssignment,
    brokenPipelines,
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
