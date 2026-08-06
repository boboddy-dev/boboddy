// Offline validation of a batch of pipeline + step definitions.
//
// These are the mistakes the type system cannot catch — either because the
// definition file was written in JS, generated, or hand-edited, or because the
// fact being checked spans two files (a route target, a cross-step binding).
// Everything here is pure: no network, no token, no server. `pushFromDirectory`
// runs it before it mutates anything, and the archetype tests run it with no
// server at all.
//
// Findings are hard errors. A signal whose `sourcePath` never resolves is
// silently dead at execution time, which is strictly worse than failing the
// push, and every message is written to be actionable on its own.

import type { PipelineDefinitionSpec } from "../pipelines/define-pipeline";
import type { StepDefinitionSpec } from "../steps/define-step";
import { resolveSourcePath, type JsonSchemaNode } from "./json-schema-paths";

export type DefinitionSpecSet = {
  readonly pipelines: readonly PipelineDefinitionSpec[];
  readonly steps: readonly StepDefinitionSpec[];
};

export type ValidateDefinitionSpecsOptions = {
  /**
   * Pipeline keys that exist outside this batch — in practice, the keys already
   * on the server. Route targets may name these as well as keys in
   * `specs.pipelines`. Omit it and only the batch counts.
   */
  readonly knownPipelineKeys?: readonly string[];
};

export type DefinitionValidationIssue = {
  readonly check: "signal-source-path" | "route-target" | "signal-binding";
  readonly message: string;
};

type SerializedBinding =
  PipelineDefinitionSpec["steps"][number]["inputBindingsJson"][string];

/** Formats a path list for an error message, capped so it stays readable. */
function listPaths(paths: readonly string[], limit = 24): string {
  if (paths.length === 0) return "";
  if (paths.length <= limit) return paths.join(", ");
  return `${paths.slice(0, limit).join(", ")}, … (${String(paths.length - limit)} more)`;
}

function quotedOrRoot(prefix: string): string {
  return prefix ? `"${prefix}"` : "the result root";
}

// ─── Check 1: every signal sourcePath resolves in the result schema ───────────

function checkSignalSourcePaths(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    const schema: JsonSchemaNode | null = step.resultSchemaJson ?? null;
    // No result schema means no shape to check against. A step can legitimately
    // declare signals with no `result` (the agent's raw JSON is whatever it is),
    // so this is left alone rather than rejected.
    if (!schema) continue;

    for (const signal of step.signalExtractorDefinitions) {
      const resolution = resolveSourcePath(schema, signal.sourcePath);
      if (resolution.kind !== "invalid") continue;

      const { resolvedPrefix, segment, reason, availablePaths } = resolution;
      const cause =
        reason === "not-an-array-index"
          ? `${quotedOrRoot(resolvedPrefix)} is an array, so "${segment}" can never index it — array segments must be numeric (e.g. "${resolvedPrefix}[0]")`
          : reason === "scalar-has-no-members"
            ? `${quotedOrRoot(resolvedPrefix)} is a scalar, so it has no property "${segment}"`
            : `${quotedOrRoot(resolvedPrefix)} has no property "${segment}"`;

      const suffix =
        availablePaths.length > 0
          ? ` Valid sourcePaths ${resolvedPrefix ? `under "${resolvedPrefix}"` : "for this step"}: ${listPaths(availablePaths)}.`
          : "";

      issues.push({
        check: "signal-source-path",
        message:
          `Step "${step.key}" declares signal "${signal.key}" with sourcePath ` +
          `"${signal.sourcePath}", which can never resolve against the step's ` +
          `result schema: ${cause}.${suffix}`,
      });
    }
  }

  return issues;
}

// ─── Check 2: route outcomes name a pipeline that exists ─────────────────────

function routeTargets(
  policy: PipelineDefinitionSpec["steps"][number]["advancementPolicyDefinition"],
): string[] {
  const keys: string[] = [];
  if (
    policy.defaultEventType === "route" &&
    typeof policy.defaultEventParamsJson?.["pipelineKey"] === "string"
  ) {
    keys.push(policy.defaultEventParamsJson["pipelineKey"]);
  }
  for (const rule of policy.rulesJson.rules) {
    if (
      rule.event.type === "route" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      keys.push(rule.event.params["pipelineKey"]);
    }
  }
  return keys;
}

function checkRouteTargets(
  pipelines: readonly PipelineDefinitionSpec[],
  knownPipelineKeys: readonly string[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];
  const known = new Set<string>([
    ...pipelines.map((pipeline) => pipeline.key),
    ...knownPipelineKeys,
  ]);

  for (const pipeline of pipelines) {
    for (const step of pipeline.steps) {
      for (const target of routeTargets(step.advancementPolicyDefinition)) {
        if (known.has(target)) continue;
        issues.push({
          check: "route-target",
          message:
            `Pipeline "${pipeline.key}" step "${step.stepKey}" routes to pipeline ` +
            `"${target}", but no pipeline with that key was found on the server or ` +
            `in the current push batch. Push the target pipeline first.`,
        });
      }
    }
  }

  return issues;
}

// ─── Check 3: signal bindings point at earlier steps that declare them ───────

/**
 * Execution order of a pipeline's steps, as array indexes.
 *
 * The server sorts by `position` and requires positions to be unique positive
 * integers, so `position` is the authority whenever it is usable. Hand-written
 * specs sometimes carry placeholder positions (0, duplicates), in which case
 * array order is the only signal available and is what `buildPipelineSpec`
 * produces anyway.
 */
function executionRanks(
  steps: PipelineDefinitionSpec["steps"],
): Map<number, number> {
  const positions = steps.map((step) => step.position);
  const usable =
    positions.every((value) => Number.isInteger(value) && value > 0) &&
    new Set(positions).size === positions.length;

  const indexes = steps.map((_, index) => index);
  const ordered = usable
    ? [...indexes].sort(
        (left, right) => (positions[left] ?? 0) - (positions[right] ?? 0),
      )
    : indexes;

  return new Map(ordered.map((index, rank) => [index, rank]));
}

function bindingSource(
  binding: SerializedBinding,
): { readonly stepKey: string; readonly signalKey: string | null } | null {
  if (binding.source === "step_signal") {
    return { stepKey: binding.stepKey, signalKey: binding.signalKey };
  }
  if (binding.source === "step_output") {
    return { stepKey: binding.stepKey, signalKey: null };
  }
  return null;
}

function declaredSignalKeys(
  stepKey: string,
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
  pipelineSteps: PipelineDefinitionSpec["steps"],
): readonly string[] | null {
  const specs = stepsByKey.get(stepKey);
  // Not in this batch — the server may already know it. Nothing provable.
  if (!specs || specs.length === 0) return null;

  const keys = new Set<string>();
  for (const spec of specs) {
    for (const signal of spec.signalExtractorDefinitions) keys.add(signal.key);
  }
  // Computed signals are declared on the pipeline step, not the step
  // definition, and are legal binding targets.
  for (const step of pipelineSteps) {
    if (step.stepKey !== stepKey) continue;
    for (const computed of step.computedSignalDefinitions)
      keys.add(computed.key);
  }
  return [...keys];
}

function checkSignalBindings(
  pipelines: readonly PipelineDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const pipeline of pipelines) {
    const ranks = executionRanks(pipeline.steps);
    const order = [...pipeline.steps.keys()]
      .sort((left, right) => (ranks.get(left) ?? 0) - (ranks.get(right) ?? 0))
      .map((index) => pipeline.steps[index]?.stepKey ?? "");
    const orderHint = `Steps in "${pipeline.key}", in order: ${order.join(" → ")}.`;

    pipeline.steps.forEach((step, index) => {
      const consumerRank = ranks.get(index) ?? index;
      const where = `Pipeline "${pipeline.key}" step "${step.stepKey}"`;

      for (const [field, binding] of Object.entries(step.inputBindingsJson)) {
        const source = bindingSource(binding);
        if (!source) continue;

        const what = source.signalKey
          ? `binds input "${field}" to signal "${source.signalKey}" of step "${source.stepKey}"`
          : `binds input "${field}" to the output of step "${source.stepKey}"`;

        const producerRanks = pipeline.steps
          .map((candidate, candidateIndex) =>
            candidate.stepKey === source.stepKey
              ? (ranks.get(candidateIndex) ?? candidateIndex)
              : null,
          )
          .filter((rank): rank is number => rank !== null);

        if (producerRanks.length === 0) {
          issues.push({
            check: "signal-binding",
            message: `${where} ${what}, but no step with that key is in the pipeline. ${orderHint}`,
          });
          continue;
        }

        if (!producerRanks.some((rank) => rank < consumerRank)) {
          issues.push({
            check: "signal-binding",
            message:
              `${where} ${what}, but that step does not run before it, so the ` +
              `value will never exist. ${orderHint}`,
          });
          continue;
        }

        if (source.signalKey === null) continue;
        const available = declaredSignalKeys(
          source.stepKey,
          stepsByKey,
          pipeline.steps,
        );
        if (available === null || available.includes(source.signalKey))
          continue;

        issues.push({
          check: "signal-binding",
          message:
            `${where} ${what}, but "${source.stepKey}" declares no such signal. ` +
            `Signals on "${source.stepKey}": ${available.length > 0 ? listPaths([...available].sort()) : "(none)"}.`,
        });
      }
    });
  }

  return issues;
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Runs every offline check over a batch of definitions and returns the issues
 * found, in check order. An empty array means the batch is clean.
 */
export function validateDefinitionSpecs(
  specs: DefinitionSpecSet,
  options: ValidateDefinitionSpecsOptions = {},
): DefinitionValidationIssue[] {
  const stepsByKey = new Map<string, StepDefinitionSpec[]>();
  for (const step of specs.steps) {
    const existing = stepsByKey.get(step.key);
    if (existing) existing.push(step);
    else stepsByKey.set(step.key, [step]);
  }

  return [
    ...checkSignalSourcePaths(specs.steps),
    ...checkRouteTargets(specs.pipelines, options.knownPipelineKeys ?? []),
    ...checkSignalBindings(specs.pipelines, stepsByKey),
  ];
}

/** `validateDefinitionSpecs`, but throws a single aggregated error. */
export function assertValidDefinitionSpecs(
  specs: DefinitionSpecSet,
  options: ValidateDefinitionSpecsOptions = {},
): void {
  const issues = validateDefinitionSpecs(specs, options);
  if (issues.length === 0) return;

  const header =
    issues.length === 1
      ? "Definition validation failed:"
      : `Definition validation failed with ${String(issues.length)} problems:`;
  throw new Error(
    [header, ...issues.map((issue) => `  • ${issue.message}`)].join("\n"),
  );
}
