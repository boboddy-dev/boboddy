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

import {
  tryComputeDominators,
  tryOrderNodeDefinitionsByTopoRank,
} from "../pipelines/chain-graph";
import {
  isWorkingNodeDefinition,
  type NodeDefinitionSpec,
  type PipelineDefinitionSpec,
} from "../pipelines/define-pipeline";
import type { SerializedBinding } from "../pipelines/bindings";
import type { StepDefinitionSpec } from "../steps/define-step";
import { resolveSourcePath, type JsonSchemaNode } from "./json-schema-paths";
import {
  checkBindingTargetFields,
  checkBindingTypeCompatibility,
  checkUnboundRequiredInputs,
} from "./validate-input-bindings";
import { listPaths, type DefinitionValidationIssue } from "./validation-issue";

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
        severity: "error",
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
          severity: "error",
          message:
            `${where} names MCP server "${check.mcp}", but the step declares no ` +
            `such server in mcpServers. Declared servers: ${mcpServerKeys.length > 0 ? listPaths([...mcpServerKeys].sort()) : "(none)"}.`,
        });
      }

      const prefix = `${check.mcp}_`;
      if (check.tool.startsWith(prefix)) {
        issues.push({
          check: "health-check-double-qualified",
          severity: "error",
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
  node: NodeDefinitionSpec,
): string[] {
  // Only `step` nodes carry an `advancementPolicyDefinition` at all —
  // nothing to check on any other kind. A hand-edited/generated spec (this
  // validator's whole reason to exist — see the file's top comment) may
  // still claim `kind: "step"` without actually setting the field, so this
  // stays a runtime check, not just a type narrowing.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hand-edited/generated spec may claim `kind: "step"` without setting the field; see file header
  if (node.kind !== "step" || !node.advancementPolicyDefinition) return [];
  const policy = node.advancementPolicyDefinition;
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
      const stepLabel =
        (isWorkingNodeDefinition(node) ? node.stepKey : undefined) ?? node.nodeKey;
      for (const target of routeTargets(node)) {
        if (known.has(target)) continue;
        issues.push({
          check: "route-target",
          severity: "error",
          pipelineKey: pipeline.key,
          nodeKey: node.nodeKey,
          message:
            `Pipeline "${pipeline.key}" step "${stepLabel}" routes to pipeline ` +
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
 * The graph's `dependencyEdges` are the authority whenever they form a
 * usable topological order (via `tryOrderNodeDefinitionsByTopoRank` — a
 * general reachability/topo-rank pass, not chain-only, so branching
 * `choice`/`loop` graphs order correctly too). Hand-written specs
 * sometimes carry a malformed graph (this validator's whole reason to
 * exist is specs that bypass `definePipeline()`'s own build-time checks —
 * see the file's top comment), in which case array order is the only
 * signal available and is what `definePipeline()` produces anyway.
 */
function executionRanks(
  nodeDefinitions: PipelineDefinitionSpec["nodeDefinitions"],
  dependencyEdges: PipelineDefinitionSpec["dependencyEdges"],
): Map<number, number> {
  const indexes = nodeDefinitions.map((_, index) => index);
  const orderedNodes = tryOrderNodeDefinitionsByTopoRank(
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
  /**
   * The producing node's *state key* (`nodeKey`) — bindings are authored
   * against `ctx.signal(nodeKey, ...)`/`ctx.output(nodeKey)`/
   * `ctx.signalsList(nodeKey)`, so the wire field named `stepKey` (kept
   * for backward-compat with the wire shape) actually holds a node key,
   * not necessarily the underlying step definition's own `key`.
   */
  readonly nodeKey: string;
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
    return { nodeKey: binding.stepKey, signalKey: binding.signalKey, kind: "signal" };
  }
  if (binding.source === "step_output") {
    return { nodeKey: binding.stepKey, signalKey: null, kind: "output" };
  }
  if (binding.source === "signals_list") {
    return { nodeKey: binding.stepKey, signalKey: null, kind: "signals_list" };
  }
  return null;
}

function declaredSignalKeys(
  producerNode: NodeDefinitionSpec,
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): readonly string[] | null {
  // A hand-edited/generated spec (see the file's top comment) may claim a
  // working `kind` without actually setting `stepKey`/
  // `computedSignalDefinitions`, so these stay runtime-defensive, not just
  // type narrowings.
  const stepKey = isWorkingNodeDefinition(producerNode)
    ? producerNode.stepKey
    : undefined;
  const specs = stepKey ? stepsByKey.get(stepKey) : undefined;
  const computedSignalDefinitions =
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hand-edited/generated spec may claim `kind: "step"` without setting the field; see file header
    (producerNode.kind === "step" ? producerNode.computedSignalDefinitions : []) ?? [];
  const keys = new Set<string>();
  for (const spec of specs ?? []) {
    for (const signal of spec.signalExtractorDefinitions) keys.add(signal.key);
  }
  // Computed signals are declared on the pipeline node, not the step
  // definition, and are legal binding targets.
  for (const computed of computedSignalDefinitions) {
    keys.add(computed.key);
  }
  // Not in this batch and no computed signals of its own — the server may
  // already know the underlying step. Nothing provable.
  if (!specs && computedSignalDefinitions.length === 0) {
    return null;
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
      .map((index) => pipeline.nodeDefinitions[index]?.nodeKey ?? "");
    const orderHint = `Nodes in "${pipeline.key}", in order: ${order.join(" → ")}.`;
    const nodeByKey = new Map(
      pipeline.nodeDefinitions.map((node) => [node.nodeKey, node]),
    );
    // The real correctness question is "does the producer run on *every*
    // path to the consumer" (dominance), not merely "does it run at an
    // earlier rank" — a topo-rank linearization allows a producer that only
    // fires down one `choice` branch to still rank below a consumer it
    // converges into from another branch. Falls back to the old rank
    // comparison only when the graph is too malformed for a dominator tree
    // to mean anything (`tryComputeDominators` returns `null` — see its own
    // doc comment), same "array order is all that's left" bias
    // `executionRanks` already documents above.
    const dominatorSets = tryComputeDominators(
      pipeline.nodeDefinitions,
      pipeline.dependencyEdges,
      pipeline.entryNodeKey,
    );

    pipeline.nodeDefinitions.forEach((node, index) => {
      const consumerRank = ranks.get(index) ?? index;
      const where = `Pipeline "${pipeline.key}" node "${node.nodeKey}"`;

      // As above: a hand-edited/generated working-kind node may not
      // actually set `inputBindingsJson` at runtime.
      const inputBindingsJson =
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hand-edited/generated working-kind node may not actually set `inputBindingsJson` at runtime; see file header
        (isWorkingNodeDefinition(node) ? node.inputBindingsJson : {}) ?? {};
      for (const [field, binding] of Object.entries(inputBindingsJson)) {
        const source = bindingSource(binding);
        if (!source) continue;

        const what =
          source.kind === "signal"
            ? `binds input "${field}" to signal "${source.signalKey ?? ""}" of node "${source.nodeKey}"`
            : source.kind === "signals_list"
              ? `binds input "${field}" to the signals list of fan-out node "${source.nodeKey}"`
              : `binds input "${field}" to the output of node "${source.nodeKey}"`;

        const issueBase = {
          severity: "error" as const,
          pipelineKey: pipeline.key,
          nodeKey: node.nodeKey,
          targetNodeKey: source.nodeKey,
        };

        const producerNode = nodeByKey.get(source.nodeKey);
        const producerRank = producerNode
          ? (ranks.get(pipeline.nodeDefinitions.indexOf(producerNode)) ?? null)
          : null;

        if (!producerNode || producerRank === null) {
          issues.push({
            check: "signal-binding",
            ...issueBase,
            message: `${where} ${what}, but no node with that key is in the pipeline. ${orderHint}`,
          });
          continue;
        }

        // A node trivially dominates itself (`dom(n)` always contains `n`),
        // but a binding referencing its own node is still never satisfiable
        // — the node hasn't produced anything yet at the point its own
        // bindings resolve — so self-reference is excluded here rather than
        // treated as "runs on every path to itself."
        const producesBeforeConsumer =
          dominatorSets !== null
            ? source.nodeKey !== node.nodeKey &&
              (dominatorSets.get(node.nodeKey)?.has(source.nodeKey) ?? false)
            : producerRank < consumerRank;

        if (!producesBeforeConsumer) {
          issues.push({
            check: "signal-binding",
            ...issueBase,
            message:
              `${where} ${what}, but that node does not run on every path ` +
              `leading to this node, so the value may not exist. ${orderHint}`,
          });
          continue;
        }

        if (source.signalKey === null) continue;
        const available = declaredSignalKeys(producerNode, stepsByKey);
        if (available === null || available.includes(source.signalKey))
          continue;

        issues.push({
          check: "signal-binding",
          ...issueBase,
          message:
            `${where} ${what}, but "${source.nodeKey}" declares no such signal. ` +
            `Signals on "${source.nodeKey}": ${available.length > 0 ? listPaths([...available].sort()) : "(none)"}.`,
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
    ...checkUnboundRequiredInputs(specs.pipelines, stepsByKey),
    ...checkBindingTargetFields(specs.pipelines, stepsByKey),
    ...checkBindingTypeCompatibility(specs.pipelines, stepsByKey),
  ];
}

/**
 * `validateDefinitionSpecs`, but throws a single aggregated error.
 *
 * Only counts and lists `severity: "error"` issues — `"warning"`-tier issues
 * (`binding-type-mismatch`) and `"info"`-tier issues (`binding-target-field`'s
 * unbound-field-name sub-check) never block a push and are silently dropped
 * from both the header count and the body here. They're still present in
 * `validateDefinitionSpecs`'s own return value for any caller that wants to
 * surface them (e.g. the designer, in a later phase); this is the one entry
 * point whose whole job is "should this push be blocked."
 */
export function assertValidDefinitionSpecs(
  specs: DefinitionSpecSet,
  options: ValidateDefinitionSpecsOptions = {},
): void {
  const issues = validateDefinitionSpecs(specs, options).filter(
    (issue) => issue.severity === "error",
  );
  if (issues.length === 0) return;

  const header =
    issues.length === 1
      ? "Definition validation failed:"
      : `Definition validation failed with ${String(issues.length)} problems:`;
  throw new Error(
    [header, ...issues.map((issue) => `  • ${issue.message}`)].join("\n"),
  );
}
