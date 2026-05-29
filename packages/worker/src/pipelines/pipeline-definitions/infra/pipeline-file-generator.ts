import { keyToVarName } from "../../../steps/step-definitions/infra/step-file-generator";

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

type StepKeyMap = Map<string, string>; // stepDefinitionId → varName
type ComputedByKey = Map<string, SerializedComputedSignalDefinition>;

// ─── Advancement policy reconstruction ───────────────────────────────────────

const OPERATOR_TO_METHOD: Record<string, string> = {
  equal: "eq",
  notEqual: "ne",
  greaterThan: "gt",
  greaterThanInclusive: "gte",
  lessThan: "lt",
  lessThanInclusive: "lte",
  in: "in",
  notIn: "notIn",
  contains: "contains",
  doesNotContain: "doesNotContain",
};

const COMPUTED_TO_CTX_METHOD: Record<string, string> = {
  average: "avg",
  weighted_average: "weightedAvg",
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

function reconstructOutcomeExpr(type: string, params: Record<string, unknown> | null | undefined): string {
  if (type !== "route") return JSON.stringify(type);
  const pipelineKey = params?.["pipelineKey"] as string | undefined;
  const inputJson = params?.["inputJson"] as Record<string, unknown> | undefined;
  if (!pipelineKey) return `"route"`;
  if (inputJson) return `route(${JSON.stringify(pipelineKey)}, ${JSON.stringify(inputJson)})`;
  return `route(${JSON.stringify(pipelineKey)})`;
}

function signalPropAccess(key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? `stepSignals.${key}` : `stepSignals[${JSON.stringify(key)}]`;
}

function reconstructFactRef(fact: string, computedByKey: ComputedByKey): string {
  const computed = computedByKey.get(fact);
  if (!computed) return signalPropAccess(fact);
  const ctxMethod = COMPUTED_TO_CTX_METHOD[computed.type] ?? computed.type;
  const args = computed.inputSignalKeys.map((k) => signalPropAccess(k)).join(", ");
  return `${ctxMethod}(${args})`;
}

// Returns a nestable expression (RuleLeaf or RuleGroup, no .then())
function reconstructNestable(cond: SerializedCondition, computedByKey: ComputedByKey): string {
  if (isLeafCondition(cond)) {
    const factRef = reconstructFactRef(cond.fact, computedByKey);
    const method = OPERATOR_TO_METHOD[cond.operator] ?? cond.operator;
    return `${factRef}.${method}(${JSON.stringify(cond.value)})`;
  }
  const mode = cond.all ? "all" : "any";
  const children = (cond[mode] ?? []).map((c) => reconstructNestable(c, computedByKey)).join(", ");
  return `${mode}(${children})`;
}

// Returns a complete rule expression ending in .then(outcome)
function reconstructRuleExpr(rule: AdvancementPolicyRule, computedByKey: ComputedByKey): string {
  const outcome = reconstructOutcomeExpr(rule.event.type, rule.event.params);
  const mode = rule.conditions.all ? "all" : "any";
  const conditions = rule.conditions[mode] ?? [];

  if (mode === "all" && conditions.length === 1 && isLeafCondition(conditions[0]!)) {
    return `${reconstructNestable(conditions[0]!, computedByKey)}.then(${outcome})`;
  }

  const nestableExprs = conditions.map((c) => reconstructNestable(c, computedByKey)).join(", ");
  return `${mode}(${nestableExprs}).then(${outcome})`;
}

function collectCtxParts(policy: AdvancementPolicy, computedByKey: ComputedByKey): string[] {
  const parts = new Set<string>();

  if (policy.defaultEventType === "route") parts.add("route");

  const visitConditions = (conditions: SerializedCondition[]) => {
    for (const cond of conditions) {
      if (isLeafCondition(cond)) {
        const computed = computedByKey.get(cond.fact);
        if (computed) {
          const method = COMPUTED_TO_CTX_METHOD[computed.type];
          if (method) parts.add(method);
        }
        parts.add("stepSignals");
      } else {
        const mode = cond.all ? "all" : "any";
        parts.add(mode);
        visitConditions(cond[mode] ?? []);
      }
    }
  };

  for (const rule of policy.rulesJson.rules) {
    if (rule.event.type === "route") parts.add("route");
    const mode = rule.conditions.all ? "all" : "any";
    visitConditions(rule.conditions[mode] ?? []);
  }

  return [...parts].sort();
}

function reconstructAdvancementCallback(policy: AdvancementPolicy, computedByKey: ComputedByKey): string {
  const rules = policy.rulesJson.rules;
  const isDefaultContinueNoRules =
    policy.defaultEventType === "continue" &&
    (!policy.defaultEventParamsJson || Object.keys(policy.defaultEventParamsJson).length === 0) &&
    rules.length === 0;

  if (isDefaultContinueNoRules) return `() => ({ default: "continue" })`;

  const ctxParts = collectCtxParts(policy, computedByKey);
  const ctxParam = ctxParts.length > 0 ? `{ ${ctxParts.join(", ")} }` : `_ctx`;

  const defaultStr = reconstructOutcomeExpr(policy.defaultEventType, policy.defaultEventParamsJson);
  const lines: string[] = [`    default: ${defaultStr}`];
  if (rules.length > 0) {
    const ruleExprs = rules.map((r) => reconstructRuleExpr(r, computedByKey)).map((r) => `      ${r}`).join(",\n");
    lines.push(`    rules: [\n${ruleExprs},\n    ]`);
  }
  return `(${ctxParam}) => ({\n${lines.join(",\n")},\n  })`;
}

// ─── Input binding reconstruction ────────────────────────────────────────────

function isAutoBinding(key: string, binding: InputBinding): boolean {
  if (binding.source !== "work_item") return false;
  return (
    (key === "workItemTitle" && binding.field === "title") ||
    (key === "workItemDescription" && binding.field === "description")
  );
}

function reconstructBindingExpr(
  binding: InputBinding,
  stepVarMap: StepKeyMap,
): string {
  switch (binding.source) {
    case "pipeline_input":
      return `input${binding.path ? `.${binding.path}` : ""}`;
    case "work_item":
      if (binding.field === "title") return "input.workItemTitle";
      if (binding.field === "description") return "input.workItemDescription";
      return `/* TODO: configure via additionalPipelineInput — workItem.field(${JSON.stringify(binding.field.replace(/^fields\./, ""))}) */ (undefined as never)`;
    case "step_signal":
      return `signal(${stepVarMap.get(binding.stepKey) ?? JSON.stringify(binding.stepKey)}, ${JSON.stringify(binding.signalKey)})`;
    case "step_output":
      return `output(${stepVarMap.get(binding.stepKey) ?? JSON.stringify(binding.stepKey)})`;
    case "literal":
      return `/* TODO: literal binding (value: ${JSON.stringify(binding.value)}) — not supported in SDK */ (undefined as never)`;
  }
}

// ─── Step mapper reconstruction ───────────────────────────────────────────────

function reconstructStepMapper(step: PipelineStepContract, stepVarMap: StepKeyMap): string {
  const allBindings = Object.entries(step.inputBindingsJson ?? {});
  // Auto-injected by the runtime; no need to emit explicit bindings for them.
  const bindings = allBindings.filter(([key, binding]) => !isAutoBinding(key, binding));

  const usesInput = bindings.some(([, b]) => b.source === "pipeline_input");
  const usesWorkItem = bindings.some(([, b]) => b.source === "work_item");
  const usesSignal = bindings.some(([, b]) => b.source === "step_signal");
  const usesOutput = bindings.some(([, b]) => b.source === "step_output");

  const ctxParts: string[] = [];
  if (usesInput || usesWorkItem) ctxParts.push("input");
  if (usesSignal) ctxParts.push("signal");
  if (usesOutput) ctxParts.push("output");

  const ctxParam = ctxParts.length > 0 ? `{ ${ctxParts.join(", ")} }` : `_ctx`;

  if (bindings.length === 0) {
    return `(${ctxParam}) => ({})`;
  }

  const bindingLines = bindings.map(([fieldKey, binding]) => {
    const expr = reconstructBindingExpr(binding, stepVarMap);
    return `    ${JSON.stringify(fieldKey)}: ${expr}`;
  });

  return `(${ctxParam}) => ({\n${bindingLines.join(",\n")},\n  })`;
}

// ─── File generator ───────────────────────────────────────────────────────────

export function generatePipelineFileContent(
  pipeline: PipelineContract,
  stepIdToKey: Map<string, string>,
): string {
  const sortedSteps = [...pipeline.stepDefinitions].sort((a, b) => a.position - b.position);

  const stepVarMap: StepKeyMap = new Map();
  for (const step of sortedSteps) {
    stepVarMap.set(step.key, keyToVarName(step.key));
  }
  for (const step of sortedSteps) {
    const defKey = stepIdToKey.get(step.stepDefinitionId);
    if (defKey && defKey !== step.key) stepVarMap.set(defKey, keyToVarName(defKey));
  }

  const stepVarNames = sortedSteps.map((s) => keyToVarName(s.key));
  const uniqueStepVarNames = [...new Set(stepVarNames)];

  const lines: string[] = [];

  lines.push(`import { pipeline } from "@boboddy/sdk/definitions/pipelines";`);
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

  const chainParts: string[] = [`pipeline({\n${metaFields.join(",\n")},\n})`];

  for (const step of sortedSteps) {
    const varName = keyToVarName(step.key);
    const mapper = reconstructStepMapper(step, stepVarMap);

    chainParts.push(`  .step(${varName}, ${mapper})`);

    if (step.timeoutSeconds !== null) {
      chainParts.push(`  .timeout(${String(step.timeoutSeconds)})`);
    }

    const computedByKey: ComputedByKey = new Map(
      step.computedSignalDefinitions.map((d) => [d.key, d]),
    );
    const advanceCallback = reconstructAdvancementCallback(step.advancementPolicyDefinition, computedByKey);
    chainParts.push(`  .advance(${advanceCallback})`);
  }

  chainParts.push(`  .build()`);

  lines.push(`export default ${chainParts.join("\n")};`);

  return lines.join("\n") + "\n";
}
