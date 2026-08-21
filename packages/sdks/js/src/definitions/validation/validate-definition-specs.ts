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

import { tryOrderChainNodeDefinitions } from "../pipelines/chain-graph";
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
  readonly check:
    | "signal-source-path"
    | "route-target"
    | "signal-binding"
    | "health-check-mcp-server"
    | "health-check-double-qualified";
  readonly message: string;
};

type SerializedBinding = NonNullable<
  PipelineDefinitionSpec["nodeDefinitions"][number]["inputBindingsJson"]
>[string];

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

// ─── Check 2: health checks reference declared, single-qualified MCP tools ───

function checkHealthChecks(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    const checks = step.healthChecksJson ?? [];
    if (checks.length === 0) continue;

    const mcpServerKeys = Object.keys(step.opencodeMcpJson ?? {});
    const mcpServerKeySet = new Set(mcpServerKeys);

    checks.forEach((check, index) => {
      const label = check.name ?? check.tool;
      const where = `Step "${step.key}" health check #${String(index + 1)} ("${label}")`;

      if (!check.mcp) return;

      if (!mcpServerKeySet.has(check.mcp)) {
        issues.push({
          check: "health-check-mcp-server",
          message:
            `${where} names MCP server "${check.mcp}", but the step declares no ` +
            `such server in mcpServers. Declared servers: ${mcpServerKeys.length > 0 ? listPaths([...mcpServerKeys].sort()) : "(none)"}.`,
        });
      }

      const prefix = `${check.mcp}_`;
      if (check.tool.startsWith(prefix)) {
        issues.push({
          check: "health-check-double-qualified",
          message:
            `${where} sets mcp "${check.mcp}" and tool "${check.tool}", which already ` +
            `starts with "${prefix}". When "mcp" is set, "tool" should be the bare tool ` +
            `name — OpenCode resolves it to "${prefix}${check.tool}". Did you mean ` +
            `tool: "${check.tool.slice(prefix.length)}"?`,
        });
      }
    });
  }

  return issues;
}

// ─── Check 3: route outcomes name a pipeline that exists ─────────────────────

function routeTargets(
  policy: PipelineDefinitionSpec["nodeDefinitions"][number]["advancementPolicyDefinition"],
): string[] {
  // `fanOut`/`cohortGate` nodes (issue #167) carry no
  // `advancementPolicyDefinition` at all — nothing to check.
  if (!policy) return [];
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
    for (const node of pipeline.nodeDefinitions) {
      for (const target of routeTargets(node.advancementPolicyDefinition)) {
        if (known.has(target)) continue;
        issues.push({
          check: "route-target",
          message:
            `Pipeline "${pipeline.key}" step "${node.stepKey ?? node.nodeKey}" routes to pipeline ` +
            `"${target}", but no pipeline with that key was found on the server or ` +
            `in the current push batch. Push the target pipeline first.`,
        });
      }
    }
  }

  return issues;
}

// ─── Check 4: signal bindings point at earlier steps that declare them ───────

/**
 * Execution order of a pipeline's nodes, as array indexes.
 *
 * The graph's `dependencyEdges` are the authority whenever they form a usable
 * chain. Hand-written specs sometimes carry a malformed graph (this
 * validator's whole reason to exist is specs that bypass the type-safe
 * builders — see the file's top comment), in which case array order is the
 * only signal available and is what `buildPipelineSpec` produces anyway.
 */
function executionRanks(
  nodeDefinitions: PipelineDefinitionSpec["nodeDefinitions"],
  dependencyEdges: PipelineDefinitionSpec["dependencyEdges"],
): Map<number, number> {
  const indexes = nodeDefinitions.map((_, index) => index);
  const orderedNodes = tryOrderChainNodeDefinitions(
    nodeDefinitions,
    dependencyEdges,
  );

  if (orderedNodes === null) {
    return new Map(indexes.map((index, rank) => [index, rank]));
  }

  const indexByNodeKey = new Map(
    nodeDefinitions.map((node, index) => [node.nodeKey, index]),
  );
  const ordered = orderedNodes.map(
    (node) => indexByNodeKey.get(node.nodeKey) ?? 0,
  );

  return new Map(ordered.map((index, rank) => [index, rank]));
}

function bindingSource(binding: SerializedBinding): {
  readonly stepKey: string;
  readonly signalKey: string | null;
  /**
   * `"signals_list"` (issue #167 — `ctx.signalsList(fanOutStep)`) still
   * requires its named fan-out to exist and run before the consumer (a
   * cohort's branches must be terminal before their signals are readable),
   * but has no single `signalKey` to check against
   * `declaredSignalKeys` — it reaches the whole cohort, not one signal.
   */
  readonly kind: "signal" | "output" | "signals_list";
} | null {
  if (binding.source === "step_signal") {
    return { stepKey: binding.stepKey, signalKey: binding.signalKey, kind: "signal" };
  }
  if (binding.source === "step_output") {
    return { stepKey: binding.stepKey, signalKey: null, kind: "output" };
  }
  if (binding.source === "signals_list") {
    return { stepKey: binding.stepKey, signalKey: null, kind: "signals_list" };
  }
  return null;
}

function declaredSignalKeys(
  stepKey: string,
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
  pipelineNodeDefinitions: PipelineDefinitionSpec["nodeDefinitions"],
): readonly string[] | null {
  const specs = stepsByKey.get(stepKey);
  // Not in this batch — the server may already know it. Nothing provable.
  if (!specs || specs.length === 0) return null;

  const keys = new Set<string>();
  for (const spec of specs) {
    for (const signal of spec.signalExtractorDefinitions) keys.add(signal.key);
  }
  // Computed signals are declared on the pipeline node, not the step
  // definition, and are legal binding targets.
  for (const node of pipelineNodeDefinitions) {
    if (node.stepKey !== stepKey) continue;
    for (const computed of node.computedSignalDefinitions ?? [])
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
    const ranks = executionRanks(
      pipeline.nodeDefinitions,
      pipeline.dependencyEdges,
    );
    const order = [...pipeline.nodeDefinitions.keys()]
      .sort((left, right) => (ranks.get(left) ?? 0) - (ranks.get(right) ?? 0))
      .map((index) => pipeline.nodeDefinitions[index]?.stepKey ?? "");
    const orderHint = `Steps in "${pipeline.key}", in order: ${order.join(" → ")}.`;

    pipeline.nodeDefinitions.forEach((node, index) => {
      const consumerRank = ranks.get(index) ?? index;
      const where = `Pipeline "${pipeline.key}" step "${node.stepKey ?? node.nodeKey}"`;

      for (const [field, binding] of Object.entries(
        node.inputBindingsJson ?? {},
      )) {
        const source = bindingSource(binding);
        if (!source) continue;

        const what =
          source.kind === "signal"
            ? `binds input "${field}" to signal "${source.signalKey ?? ""}" of step "${source.stepKey}"`
            : source.kind === "signals_list"
              ? `binds input "${field}" to the signals list of fan-out step "${source.stepKey}"`
              : `binds input "${field}" to the output of step "${source.stepKey}"`;

        const producerRanks = pipeline.nodeDefinitions
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
          pipeline.nodeDefinitions,
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
    ...checkHealthChecks(specs.steps),
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
