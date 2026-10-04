/**
 * Shared step discovery: which steps a loaded module defines, and which
 * function implements a given code step.
 *
 * Used by `collect-definitions.ts` to decide what to push and by the worker's
 * code-step runner to decide what to run, so a step is runnable exactly when
 * the collector could find it. Discovery works from the shape of a module's
 * exports, never from shared module instances.
 *
 * Takes type-only imports so it carries no runtime dependency on the rest of
 * the SDK and can be imported on its own (`@boboddy/sdk/code-step-lookup`).
 */

import type { PipelineDefinitionSpec } from "../definitions/pipelines";
import type { StepDefinitionSpec } from "../definitions/steps";

type CodeStepFn = NonNullable<StepDefinitionSpec["entrypoint"]>["fn"];

export function isStepDefinitionSpec(
  // eslint-disable-next-line local/no-unknown-parameter-type
  value: unknown,
): value is StepDefinitionSpec {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["key"] === "string" &&
    typeof obj["name"] === "string" &&
    typeof obj["version"] === "number" &&
    (obj["kind"] === "user_defined" || obj["kind"] === "code")
  );
}

export function isPipelineDefinitionSpec(
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

/**
 * Every step spec a module defines: its named exports that are step specs,
 * plus the embedded steps of its default-exported pipeline. Deduped by
 * reference, so a step both exported and embedded appears once.
 */
export function stepsInModule(
  mod: Readonly<Record<string, unknown>>,
): StepDefinitionSpec[] {
  const found = new Set<StepDefinitionSpec>();

  for (const [exportName, value] of Object.entries(mod)) {
    if (exportName !== "default" && isStepDefinitionSpec(value)) {
      found.add(value);
    }
  }

  const defaultExport = mod["default"];
  if (isPipelineDefinitionSpec(defaultExport)) {
    for (const embedded of defaultExport._stepDefinitions ?? []) {
      found.add(embedded);
    }
  }

  return [...found];
}

/**
 * The function implementing the code step `key` in `mod`, or `undefined` when
 * the module defines no such step. Throws when more than one distinct function
 * is registered under `key`; the same function reachable twice is not
 * ambiguous.
 */
export function findCodeStepInModule(
  mod: Readonly<Record<string, unknown>>,
  key: string,
): CodeStepFn | undefined {
  const fns = new Set<CodeStepFn>();

  for (const spec of stepsInModule(mod)) {
    if (spec.kind !== "code" || spec.key !== key) continue;
    const fn = spec.entrypoint?.fn;
    if (typeof fn === "function") fns.add(fn);
  }

  if (fns.size > 1) {
    throw new Error(
      `Code step "${key}" is ambiguous: ${String(fns.size)} distinct functions are registered under that key in the same module.`,
    );
  }
  return fns.values().next().value;
}
