import {
  WORK_ITEM_FIELDS_PATH_PREFIX,
  WORK_ITEM_TOP_LEVEL_FIELDS,
} from "@boboddy/sdk/definitions/pipelines";
import {
  keyToVarName,
  schemaToZodExpr,
} from "../../../steps/step-definitions/infra/step-file-generator";

/**
 * Regenerates local `.ts` pipeline source (`definePipeline({states})` — see
 * docs/research/flat-pipeline-sdk-and-visual-designer.md §4) from
 * `PipelineContract`, the shape `boboddy pipelines pull` receives off
 * `GET /projects/:projectId/pipeline-definitions`.
 *
 * ## The node-kind gap
 *
 * That read endpoint's response schema (`pipelineDefinitionSchema` in
 * `packages/core/src/pipeline-definitions/pipeline-definition/contracts/pipeline-definition-contracts.ts`)
 * only ever emits `stepDefinitions[]` — a flat, `position`-ordered array with
 * no `kind` field at all. `pipelineGraphEntityToContract` (in `packages/core`)
 * maps EVERY node in the underlying graph — `step`, `choice`, `fanOut`,
 * `cohortGate`, `parallel`, `loop`, `succeed`, `fail` alike — through
 * `nodeDefinitionEntityToStepContract`, which forces each one into this same
 * flat "step" row (synthesizing a fake `stepDefinitionId` for kinds that have
 * no step of their own, and losing each kind's own config — a `choice`'s
 * routing table, a `loop`'s `maxIterations`/`until`, a `parallel`'s branches —
 * entirely; none of it is on the wire).
 *
 * Consequently, **this generator can only ever reconstruct a `step`-only,
 * sequential chain.** It has no way to detect that a given row was actually a
 * `choice`/`fanOut`/`parallel`/`loop`/`succeed`/`fail` node, because the
 * contract never tells it — every row is treated as a plain `step` because
 * that is the only thing this contract can represent. A pipeline authored
 * with any other node kind will pull back as an (incorrect) all-`step` chain.
 * Closing this gap needs its own ticket: extending
 * `pipelineDefinitionSchema`/`pipelineGraphEntityToContract` to expose
 * `kind`/`configJson`/branch structure per node, mirroring the richer
 * `nodeDefinitions[]`/`dependencyEdges[]` shape the *write* side
 * (`pipeline-definitions-client.ts`'s `upsertFromSpec`) already accepts.
 *
 * ## What IS reconstructed faithfully
 *
 * Every node the new SDK's `compileStepState` can produce for a plain `step`
 * state compiles to exactly one of two advancement shapes on the wire (see
 * `compile-node-definitions.ts`):
 *
 * - `defaultEventType: "continue"` or `"route"`, zero rules — an
 *   unconditional `next` (or `next: { routeToPipeline }`).
 * - the same, plus exactly one rule whose `event.type` is `"block"` — a
 *   `blockWhen` condition.
 *
 * `reconstructAdvancement` below recognizes exactly these two shapes and
 * reconstructs them as `next`/`blockWhen`. Anything else on the wire — more
 * than one rule, a non-block rule outcome, or `defaultEventType: "block"`
 * with no rules — cannot have come from a `step` state authored with the
 * current SDK. It is either a pre-SDK-rewrite pipeline never re-pushed under
 * the new authoring surface, or (per the gap above) a `choice`/other node
 * kind misrepresented as a flat step. Rather than silently emit code that
 * looks plausible but drops the real routing logic, that case is reported as
 * `{ kind: "unsupported" }` and rendered as a loud `PULL WARNING` comment
 * directly on the affected state, with a best-effort `next` guess (continue
 * to whatever step is next in `position` order) so the file still compiles
 * and a human can fix it by hand.
 */

// The top-level field list is imported from the SDK rather than duplicated
// here, so this generator and the regular pipeline/step `WorkItemAccessor`
// (`builder-helpers.ts`) can never drift out of sync — see the identical
// rationale in `default-pipeline-assignment-file-generator.ts`, which reuses
// the same constant for its own (JSONPath-rooted) reverse-generation.
const WORK_ITEM_TOP_LEVEL_FIELD_SET = new Set<string>(WORK_ITEM_TOP_LEVEL_FIELDS);

type InputBinding =
  | { source: "pipeline_input"; path: string | null }
  | { source: "work_item"; field: string }
  | { source: "step_output"; stepKey: string; path?: string | null }
  | { source: "step_signal"; stepKey: string; signalKey: string }
  | { source: "literal"; value: unknown };

type AdvancementPolicyRule = {
  conditions: {
    all?: SerializedCondition[];
    any?: SerializedCondition[];
  };
  event: { type: string; params?: Record<string, unknown> | null };
};

type SerializedLeafCondition = { fact: string; operator: string; value: unknown };
type SerializedConditionGroup = { all?: SerializedCondition[]; any?: SerializedCondition[] };
type SerializedCondition = SerializedLeafCondition | SerializedConditionGroup;

type AdvancementPolicy = {
  rulesJson: { rules: AdvancementPolicyRule[] };
  defaultEventType: string;
  defaultEventParamsJson: Record<string, unknown> | null;
  allowedEventTypes: string[];
};

type SerializedComputedSignalDefinition = {
  key: string;
  type: string;
  inputSignalKeys: string[];
  configJson: Record<string, unknown> | null;
  availableWhenResultStatusIn: string[] | null;
};

export type PipelineStepContract = {
  stepDefinitionId: string;
  stepDefinitionVersion: number;
  key: string;
  name: string;
  description: string | null;
  position: number;
  inputBindingsJson: Record<string, InputBinding> | null;
  timeoutSeconds: number | null;
  advancementPolicyDefinition: AdvancementPolicy;
  computedSignalDefinitions: SerializedComputedSignalDefinition[];
};

export type PipelineContract = {
  key: string;
  name: string;
  description: string | null;
  version: number;
  status: string;
  inputSchemaJson: Record<string, unknown> | null;
  stepDefinitions: PipelineStepContract[];
};

type ComputedByKey = Map<string, SerializedComputedSignalDefinition>;

// ─── Condition reconstruction ─────────────────────────────────────────────

/**
 * Maps a computed signal's wire `type` to its `Computed.<factory>` name.
 * Mirrors `COMPUTED_TO_CTX_METHOD`'s old mapping, just targeting the
 * `Computed` namespace instead of a `.advance()` ctx method.
 */
const COMPUTED_TYPE_TO_FACTORY: Record<string, string> = {
  average: "average",
  weighted_average: "weightedAverage",
  sum: "sum",
  min: "min",
  max: "max",
  count: "count",
  boolean_any: "booleanAny",
  boolean_all: "booleanAll",
};

function isLeafCondition(c: SerializedCondition): c is SerializedLeafCondition {
  return "fact" in c;
}

/** A condition's `signal` argument: a plain signal key, or `Computed.X([...])`. */
function reconstructFactRef(fact: string, computedByKey: ComputedByKey): string {
  const computed = computedByKey.get(fact);
  if (!computed) return JSON.stringify(fact);
  const factory = COMPUTED_TYPE_TO_FACTORY[computed.type] ?? computed.type;
  const keys = computed.inputSignalKeys.map((k) => JSON.stringify(k)).join(", ");
  return `Computed.${factory}([${keys}])`;
}

/**
 * Reconstructs a condition (leaf or `all`/`any` group) as a nestable
 * `Rule.signal(...)`/`Rule.all([...])`/`Rule.any([...])` expression — no
 * outcome, since these only ever feed `blockWhen`/a `choice`'s `when`/a
 * `loop`'s `until` in the new SDK.
 */
function reconstructConditionTree(cond: SerializedCondition, computedByKey: ComputedByKey): string {
  if (isLeafCondition(cond)) {
    return `Rule.signal(${reconstructFactRef(cond.fact, computedByKey)}, ${JSON.stringify(cond.operator)}, ${JSON.stringify(cond.value)})`;
  }
  const mode = cond.all ? "all" : "any";
  const children = (cond[mode] ?? []).map((c) => reconstructConditionTree(c, computedByKey)).join(", ");
  return `Rule.${mode}([${children}])`;
}

/**
 * Reconstructs a single-rule advancement policy's condition group as a
 * `blockWhen`-ready expression. The common single-leaf-`all` shape (what
 * `Rule.when(...)` itself produces) collapses back to a bare `Rule.when(...)`
 * call rather than a redundant `Rule.all([Rule.signal(...)])`.
 */
function reconstructBlockWhenExpr(rule: AdvancementPolicyRule, computedByKey: ComputedByKey): string {
  const mode = rule.conditions.all ? "all" : "any";
  const conditions = rule.conditions[mode] ?? [];
  const first = conditions[0];
  if (mode === "all" && conditions.length === 1 && first !== undefined && isLeafCondition(first)) {
    return `Rule.when(${reconstructFactRef(first.fact, computedByKey)}, ${JSON.stringify(first.operator)}, ${JSON.stringify(first.value)})`;
  }
  const children = conditions.map((c) => reconstructConditionTree(c, computedByKey)).join(", ");
  return `Rule.${mode}([${children}])`;
}

// ─── Input binding reconstruction ────────────────────────────────────────────

function isAutoBinding(key: string, binding: InputBinding): boolean {
  return (
    binding.source === "work_item" &&
    ((key === "workItemTitle" && binding.field === "title") ||
      (key === "workItemDescription" && binding.field === "description"))
  );
}

/**
 * Reconstructs a `WorkItemAccessor` expression (`builder-helpers.ts`) for a
 * `work_item` binding's `field` value: `ctx.workItem.<field>` for any of
 * `WORK_ITEM_TOP_LEVEL_FIELDS`, `ctx.workItem.field("<name>")` for a
 * `fields.<name>` reference into the platform-specific `fields` bag.
 *
 * Checking top-level-field membership first (rather than special-casing
 * only `title`/`description`) matters now that `WORK_ITEM_TOP_LEVEL_FIELDS`
 * covers more than those two — a field like `"platform"` must reconstruct
 * as `ctx.workItem.platform`, not `ctx.workItem.field("platform")`.
 */
function reconstructWorkItemExpr(field: string): string {
  if (WORK_ITEM_TOP_LEVEL_FIELD_SET.has(field)) return `ctx.workItem.${field}`;
  const fieldName = field.startsWith(WORK_ITEM_FIELDS_PATH_PREFIX)
    ? field.slice(WORK_ITEM_FIELDS_PATH_PREFIX.length)
    : field;
  return `ctx.workItem.field(${JSON.stringify(fieldName)})`;
}

function reconstructBindingExpr(binding: InputBinding): string {
  switch (binding.source) {
    case "pipeline_input":
      return `ctx.pipelineInput(${JSON.stringify(binding.path ?? "")})`;
    case "work_item":
      return reconstructWorkItemExpr(binding.field);
    case "step_signal":
      // `stepKey` here is the wire name for what the new SDK calls a node's
      // own state key (see `bindings.ts`'s `serializeBinding` — a
      // `step_signal` binding's `stepKey` is `ctx.signal`'s `nodeKey`
      // argument, not the underlying step definition's own key).
      return `ctx.signal(${JSON.stringify(binding.stepKey)}, ${JSON.stringify(binding.signalKey)})`;
    case "step_output":
      return `ctx.output(${JSON.stringify(binding.stepKey)})`;
    case "literal":
      return `ctx.literal(${JSON.stringify(binding.value)})`;
  }
}

/** A JS object-literal key: bare when it's a valid identifier, quoted otherwise. */
function objectKeyLiteral(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function reconstructInputMapper(step: PipelineStepContract): string {
  const allBindings = Object.entries(step.inputBindingsJson ?? {});
  // Auto-injected by the runtime; no need to emit explicit bindings for them.
  const bindings = allBindings.filter(([key, binding]) => !isAutoBinding(key, binding));

  if (bindings.length === 0) return `() => ({})`;

  const bindingLines = bindings.map(
    ([fieldKey, binding]) => `    ${objectKeyLiteral(fieldKey)}: ${reconstructBindingExpr(binding)}`,
  );
  return `(ctx) => ({\n${bindingLines.join(",\n")},\n  })`;
}

// ─── Per-step advancement → next/blockWhen ───────────────────────────────────

type RouteTarget = { pipelineKey: string; inputJson?: Record<string, unknown> };

type ReconstructedAdvancement =
  | { kind: "ok"; blockWhenExpr: string | null; routeTo: RouteTarget | null }
  | { kind: "unsupported"; reason: string };

/**
 * Classifies one step's advancement policy into the `next`/`blockWhen` shape
 * a flat `step` state can express, or flags it as unsupported. See this
 * file's module doc for exactly which wire shapes are reconstructable and
 * why.
 */
function reconstructAdvancement(
  policy: AdvancementPolicy,
  computedByKey: ComputedByKey,
): ReconstructedAdvancement {
  const rules = policy.rulesJson.rules;

  const routeTo: RouteTarget | null =
    policy.defaultEventType === "route" &&
    typeof policy.defaultEventParamsJson?.["pipelineKey"] === "string"
      ? {
          pipelineKey: policy.defaultEventParamsJson["pipelineKey"],
          ...(policy.defaultEventParamsJson["inputJson"]
            ? { inputJson: policy.defaultEventParamsJson["inputJson"] as Record<string, unknown> }
            : {}),
        }
      : null;

  if (policy.defaultEventType !== "continue" && policy.defaultEventType !== "route") {
    return {
      kind: "unsupported",
      reason:
        `defaultEventType ${JSON.stringify(policy.defaultEventType)} has no equivalent on a plain ` +
        `"step" state in the flat SDK — only "continue" and "route" are. This node's routing may ` +
        `depend on a "choice"/other node kind the read API cannot distinguish from a plain step ` +
        `(see this file's module doc).`,
    };
  }
  if (rules.length === 0) {
    return { kind: "ok", blockWhenExpr: null, routeTo };
  }
  if (rules.length > 1) {
    return {
      kind: "unsupported",
      reason:
        `${String(rules.length)} advancement rules — a flat "step" state supports at most one ` +
        `blockWhen condition. This node's routing likely needs a "choice" state, which the read ` +
        `API cannot reconstruct (see this file's module doc).`,
    };
  }
  const rule = rules[0];
  if (!rule || rule.event.type !== "block") {
    return {
      kind: "unsupported",
      reason:
        `advancement rule resolves to ${JSON.stringify(rule?.event.type)}, not "block" — a flat ` +
        `"step" state has no way to conditionally reach an outcome other than block/continue/route.`,
    };
  }
  return { kind: "ok", blockWhenExpr: reconstructBlockWhenExpr(rule, computedByKey), routeTo };
}

function routeToExpr(routeTo: RouteTarget): string {
  const inputPart = routeTo.inputJson ? `, input: ${JSON.stringify(routeTo.inputJson)}` : "";
  return `{ routeToPipeline: ${JSON.stringify(routeTo.pipelineKey)}${inputPart} }`;
}

// ─── File generator ───────────────────────────────────────────────────────────

/** Picks a `succeed` terminal key that can't collide with an authored node key. */
function pickTerminalKey(usedKeys: ReadonlySet<string>): string {
  let key = "done";
  while (usedKeys.has(key)) key = `_${key}`;
  return key;
}

export function generatePipelineFileContent(
  pipeline: PipelineContract,
  stepIdToKey: Map<string, string>,
): string {
  const sortedSteps = [...pipeline.stepDefinitions].sort((a, b) => a.position - b.position);

  const varNameByNodeKey = new Map<string, string>();
  for (const step of sortedSteps) {
    const stepDefKey = stepIdToKey.get(step.stepDefinitionId) ?? step.key;
    varNameByNodeKey.set(step.key, keyToVarName(stepDefKey));
  }
  const uniqueStepVarNames = [...new Set(varNameByNodeKey.values())];

  const terminalKey = pickTerminalKey(new Set(sortedSteps.map((s) => s.key)));

  type RenderedState = {
    text: string;
    usesRuleImport: boolean;
    usesComputedImport: boolean;
    targetsTerminal: boolean;
  };

  const rendered: RenderedState[] = sortedSteps.map((step, index) => {
    const varName = varNameByNodeKey.get(step.key) ?? keyToVarName(step.key);
    const computedByKey: ComputedByKey = new Map(
      step.computedSignalDefinitions.map((d) => [d.key, d]),
    );
    const advancement = reconstructAdvancement(step.advancementPolicyDefinition, computedByKey);
    const nextStepKey = sortedSteps[index + 1]?.key;

    let leadingComment = "";
    let blockWhenLine = "";
    let nextExpr: string;
    let usesRuleImport = false;
    let usesComputedImport = false;
    let targetsTerminal = false;

    if (advancement.kind === "unsupported") {
      leadingComment =
        `    // PULL WARNING: could not fully reconstruct this state's advancement policy — ` +
        `${advancement.reason}\n` +
        `    // Falling back to an unconditional \`next\` — verify this by hand before pushing.\n`;
      // Best-effort fallback so the file still compiles: continue to the next
      // positional step, or to the synthesized terminal if this was last.
      if (nextStepKey !== undefined) {
        nextExpr = JSON.stringify(nextStepKey);
      } else {
        nextExpr = JSON.stringify(terminalKey);
        targetsTerminal = true;
      }
    } else {
      if (advancement.blockWhenExpr) {
        blockWhenLine = `    blockWhen: ${advancement.blockWhenExpr},\n`;
        usesRuleImport = true;
        usesComputedImport = advancement.blockWhenExpr.includes("Computed.");
      }
      if (advancement.routeTo) {
        nextExpr = routeToExpr(advancement.routeTo);
      } else if (nextStepKey !== undefined) {
        nextExpr = JSON.stringify(nextStepKey);
      } else {
        nextExpr = JSON.stringify(terminalKey);
        targetsTerminal = true;
      }
    }

    const timeoutLine =
      step.timeoutSeconds !== null ? `    timeout: ${String(step.timeoutSeconds)},\n` : "";

    const text =
      `  ${objectKeyLiteral(step.key)}: {\n` +
      leadingComment +
      `    kind: "step",\n` +
      `    step: ${varName},\n` +
      `    input: ${reconstructInputMapper(step)},\n` +
      blockWhenLine +
      timeoutLine +
      `    next: ${nextExpr},\n` +
      `  }`;

    return { text, usesRuleImport, usesComputedImport, targetsTerminal };
  });

  const needsRuleImport = rendered.some((r) => r.usesRuleImport);
  const needsComputedImport = rendered.some((r) => r.usesComputedImport);
  const terminalNeeded = sortedSteps.length === 0 || rendered.some((r) => r.targetsTerminal);

  const stateEntries = rendered.map((r) => r.text);
  if (terminalNeeded) {
    stateEntries.push(`  ${objectKeyLiteral(terminalKey)}: { kind: "succeed" }`);
  }

  const usesPipelineInputSchema = pipeline.inputSchemaJson !== null;

  const lines: string[] = [];
  if (usesPipelineInputSchema) lines.push(`import { z } from "zod";`);

  const pipelineImports = ["definePipeline"];
  if (needsRuleImport) pipelineImports.push("Rule");
  if (needsComputedImport) pipelineImports.push("Computed");
  lines.push(`import { ${pipelineImports.join(", ")} } from "@boboddy/sdk/definitions/pipelines";`);
  if (uniqueStepVarNames.length > 0) {
    lines.push(`import { ${uniqueStepVarNames.join(", ")} } from "./steps";`);
  }
  lines.push("");

  const metaFields: string[] = [
    `  key: ${JSON.stringify(pipeline.key)}`,
    `  name: ${JSON.stringify(pipeline.name)}`,
  ];
  if (pipeline.description) metaFields.push(`  description: ${JSON.stringify(pipeline.description)}`);
  metaFields.push(`  version: ${String(pipeline.version)}`);
  metaFields.push(`  status: ${JSON.stringify(pipeline.status)} as const`);
  if (usesPipelineInputSchema) {
    metaFields.push(`  input: ${schemaToZodExpr(pipeline.inputSchemaJson)}`);
  }
  const startAt = sortedSteps[0]?.key ?? terminalKey;
  metaFields.push(`  startAt: ${JSON.stringify(startAt)}`);
  metaFields.push(`  states: {\n${stateEntries.join(",\n")},\n  }`);

  lines.push(`export default definePipeline({\n${metaFields.join(",\n")},\n});`);

  return lines.join("\n") + "\n";
}
