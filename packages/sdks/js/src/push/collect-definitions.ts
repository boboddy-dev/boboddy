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
import {
  isPipelineDefinitionSpec,
  isStepDefinitionSpec,
  stepsInModule,
} from "./code-step-lookup";

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

type RegisteredCodeStep = {
  readonly version: number;
  readonly fn: unknown;
  readonly sourceFile: string;
};

type CollectedPipeline = {
  readonly spec: PipelineDefinitionSpec;
  readonly sourceFile: string;
};

/** Mutable accumulator shared by every file of one collection run. */
type CollectionState = {
  readonly pipelines: CollectedPipeline[];
  readonly stepMap: Map<string, StepDefinitionSpec>;
  readonly codeSteps: Map<string, RegisteredCodeStep>;
};

function createCollectionState(): CollectionState {
  return { pipelines: [], stepMap: new Map(), codeSteps: new Map() };
}

/**
 * Records a code step under its `key` and throws when the key is already
 * taken by a step with a different version or a different `fn` — the worker
 * finds a code step by `key` alone, so a shared key must mean one function.
 */
function registerCodeStep(
  state: CollectionState,
  spec: StepDefinitionSpec,
  sourceFile: string,
): void {
  const fn = spec.entrypoint?.fn;
  if (spec.kind !== "code" || !fn) return;

  const existing = state.codeSteps.get(spec.key);
  if (!existing) {
    state.codeSteps.set(spec.key, { version: spec.version, fn, sourceFile });
    return;
  }
  if (existing.version !== spec.version) {
    throw new Error(
      `Code step "${spec.key}" is defined with different versions ` +
        `(v${String(existing.version)} in ${existing.sourceFile}, v${String(spec.version)} in ${sourceFile}). ` +
        `A code step is found by key alone, so give each code step a unique key.`,
    );
  }
  if (existing.fn !== fn) {
    throw new Error(
      `Code step "${spec.key}" is defined with different fn references ` +
        `(${existing.sourceFile} and ${sourceFile}). ` +
        `A code step is found by key alone, so give each code step a unique key.`,
    );
  }
}

/**
 * For a `kind === "code"` spec: records `sourceFile` — the file that defines
 * the step, relative to the repo root as `PIPELINE_BUILDER_DIR/<file>`, since
 * `absDir` (the directory being collected) is always `PIPELINE_BUILDER_DIR`
 * itself — as `entrypointJson`, and strips the live `fn` reference (it can
 * never be serialized into the push request). Every other kind passes
 * through unchanged.
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
  absoluteFilePath: string,
  absDir: string,
): StepDefinitionSpec {
  if (spec.kind !== "code") return spec;

  if (!spec.entrypoint?.fn) {
    throw new Error(
      `Code step "${spec.key}" (kind: "code") has no entrypoint.fn. ` +
        `Build it with codeStep({ fn, ... }) from "@boboddy/sdk/definitions/steps".`,
    );
  }

  const resolved: StepDefinitionSpec = { ...spec };
  delete resolved.entrypoint;
  resolved.entrypointJson = {
    sourceFile: join(PIPELINE_BUILDER_DIR, relative(absDir, absoluteFilePath)),
  };
  return resolved;
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
 * Imports one source file and folds whatever it exports into `state` — the
 * per-file body shared by both `collectDefinitionsFromDirectory` (which lets a
 * throw here propagate straight out) and
 * `collectDefinitionsFromDirectoryTolerant` (which catches it per file).
 *
 * Code steps reachable from the module (named exports and the default
 * pipeline's embedded steps, as `stepsInModule` sees them) are registered
 * first, so a key conflict rejects the whole file before any of it is kept.
 */
async function collectFile(
  absoluteFilePath: string,
  absDir: string,
  state: CollectionState,
): Promise<void> {
  const mod = await importModule(absoluteFilePath);

  for (const step of stepsInModule(mod)) {
    registerCodeStep(state, step, absoluteFilePath);
  }

  const defaultExport = mod["default"];
  if (isPipelineDefinitionSpec(defaultExport)) {
    state.pipelines.push({
      spec: defaultExport,
      sourceFile: absoluteFilePath,
    });
  }

  for (const [exportName, value] of Object.entries(mod)) {
    if (exportName === "default" || !isStepDefinitionSpec(value)) continue;
    const resolved = resolveCodeStepEntrypoint(value, absoluteFilePath, absDir);
    state.stepMap.set(`${resolved.key}@v${String(resolved.version)}`, resolved);
  }
}

/**
 * Pick up steps embedded in a pipeline (steps not explicitly exported). Named
 * exports take precedence — an embedded step already collected from a direct
 * export is skipped here. An embedded `kind: "code"` step resolves to the
 * file of the pipeline that embeds it.
 */
function foldEmbeddedSteps(
  pipeline: CollectedPipeline,
  absDir: string,
  stepMap: Map<string, StepDefinitionSpec>,
): void {
  for (const embedded of pipeline.spec._stepDefinitions ?? []) {
    const key = `${embedded.key}@v${String(embedded.version)}`;
    if (stepMap.has(key)) continue;
    stepMap.set(
      key,
      resolveCodeStepEntrypoint(embedded, pipeline.sourceFile, absDir),
    );
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
 * validation failure, a conflicting `codeStep` key — aborting the
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

  const state = createCollectionState();

  for (const file of sourceFiles) {
    await collectFile(join(absDir, file), absDir, state);
  }

  for (const pipeline of state.pipelines) {
    foldEmbeddedSteps(pipeline, absDir, state.stepMap);
  }

  return {
    pipelines: state.pipelines.map((pipeline) => pipeline.spec),
    steps: [...state.stepMap.values()],
    defaultPipelineAssignment: await collectDefaultPipelineAssignment(absDir),
  };
}

/**
 * `collectDefinitionsFromDirectory`'s tolerant sibling, built for `boboddy
 * pipelines studio`: one file failing to import or compile (a syntax error,
 * an `assertTargetExists`-style `definePipeline()` throw, a conflicting
 * `codeStep` key, ...) is recorded as a `BrokenPipeline` entry instead
 * of aborting collection — every *other* file's pipeline still comes back
 * usable, so one bad edit in the builder directory doesn't blank the whole
 * designer (see `compute-studio-snapshot.ts`).
 */
export async function collectDefinitionsFromDirectoryTolerant(
  dir: string,
): Promise<TolerantCollectedDefinitions> {
  const absDir = resolve(dir);
  const sourceFiles = listSourceFiles(absDir);

  const state = createCollectionState();
  const brokenPipelines: BrokenPipeline[] = [];

  for (const file of sourceFiles) {
    try {
      await collectFile(join(absDir, file), absDir, state);
    } catch (error) {
      brokenPipelines.push({
        key: fileNameWithoutExtension(file),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A pipeline that imported fine can still turn out broken here, if one of
  // its embedded code steps is malformed (no `entrypoint.fn`) — pulled out
  // of `pipelines` and reported the same way as an import-time failure.
  const okPipelines: PipelineDefinitionSpec[] = [];
  for (const pipeline of state.pipelines) {
    try {
      foldEmbeddedSteps(pipeline, absDir, state.stepMap);
      okPipelines.push(pipeline.spec);
    } catch (error) {
      brokenPipelines.push({
        key: pipeline.spec.key,
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
    steps: [...state.stepMap.values()],
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
