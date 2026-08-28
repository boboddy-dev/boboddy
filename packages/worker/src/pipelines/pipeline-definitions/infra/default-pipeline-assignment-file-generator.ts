import {
  WORK_ITEM_FIELDS_PATH_PREFIX,
  WORK_ITEM_TOP_LEVEL_FIELDS,
} from "@boboddy/sdk/definitions/pipelines";
import { keyToVarName } from "../../../steps/step-definitions/infra/step-file-generator";

// ─── Types matching the server-side wire format ───────────────────────────────

type SerializedLeafCondition = {
  fact: string;
  path?: string;
  operator: string;
  value: unknown;
};
type SerializedConditionGroup = {
  all?: SerializedConditionNode[];
  any?: SerializedConditionNode[];
};
type SerializedConditionNode =
  SerializedLeafCondition | SerializedConditionGroup;

type AssignmentPolicyRule = {
  conditions: {
    all?: SerializedConditionNode[];
    any?: SerializedConditionNode[];
  };
  event: { type: string; params?: Record<string, unknown> | null };
};

export type DefaultPipelineAssignmentContract = {
  pipelineDefinitionId: string;
  rulesJson: { rules: AssignmentPolicyRule[] };
  defaultEventType: "assign" | "skip";
  defaultEventParamsJson: Record<string, unknown> | null;
  allowedEventTypes: Array<"assign" | "skip">;
};

// ─── Supported fact/path patterns ─────────────────────────────────────────────
//
//   fact: "workItem", path: "$.fields.<name>"  →  workItem.field("<name>")
//   fact: "workItem", path: "$.<topLevelField>" →  workItem.<topLevelField>
//   fact: "context",  path: "$.isNew"          →  context.isNew
//
// The top-level field list is imported from the SDK (`WORK_ITEM_TOP_LEVEL_FIELDS`)
// rather than duplicated here, so this generator and the fluent DSL's
// `ctx.workItem` accessor can never drift out of sync (see issue #125, where a
// prior version of this drift produced pull output that didn't typecheck).
const WORK_ITEM_TOP_LEVEL_PATHS = new Map<string, string>(
  WORK_ITEM_TOP_LEVEL_FIELDS.map((field) => [`$.${field}`, field]),
);

const WORK_ITEM_FACT = "workItem";
// The SDK's `WORK_ITEM_FIELDS_PATH_PREFIX` is the bare `"fields."` key
// prefix (shared with the regular pipeline/step accessor, which has no
// JSONPath root); this DSL's paths are JSONPath-rooted at `$.`, hence the
// prepended `$.` here.
const WORK_ITEM_FIELDS_JSON_PATH_PREFIX = `$.${WORK_ITEM_FIELDS_PATH_PREFIX}`;
const CONTEXT_FACT = "context";
const CONTEXT_IS_NEW_PATH = "$.isNew";

// ─── Operator mapping ─────────────────────────────────────────────────────────

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

// ─── Error type ───────────────────────────────────────────────────────────────

/**
 * Thrown when server-side rules contain shapes that cannot be reconstructed
 * using the SDK's fluent DSL.
 */
export class UnsupportedRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRuleError";
  }
}

// ─── Condition reconstruction ─────────────────────────────────────────────────

function isLeafCondition(
  c: SerializedConditionNode,
): c is SerializedLeafCondition {
  return "fact" in c;
}

function reconstructFactRef(fact: string, path: string | undefined): string {
  if (fact === CONTEXT_FACT && path === CONTEXT_IS_NEW_PATH) {
    return "context.isNew";
  }
  if (fact === WORK_ITEM_FACT && path !== undefined) {
    const topLevelField = WORK_ITEM_TOP_LEVEL_PATHS.get(path);
    if (topLevelField) {
      return `workItem.${topLevelField}`;
    }
    if (path.startsWith(WORK_ITEM_FIELDS_JSON_PATH_PREFIX)) {
      const fieldName = path.slice(WORK_ITEM_FIELDS_JSON_PATH_PREFIX.length);
      return `workItem.field(${JSON.stringify(fieldName)})`;
    }
  }
  const desc = path ? `fact "${fact}" path "${path}"` : `fact "${fact}"`;
  throw new UnsupportedRuleError(
    `Unsupported condition ${desc}. Only workItem.field(...), workItem.<${WORK_ITEM_TOP_LEVEL_FIELDS.join("|")}>, and context.isNew are supported by the fluent SDK.`,
  );
}

function reconstructNestable(cond: SerializedConditionNode): string {
  if (isLeafCondition(cond)) {
    const factRef = reconstructFactRef(cond.fact, cond.path);
    const method = OPERATOR_TO_METHOD[cond.operator];
    if (!method) {
      throw new UnsupportedRuleError(
        `Unsupported operator "${cond.operator}". Cannot reconstruct fluent SDK expression.`,
      );
    }
    return `${factRef}.${method}(${JSON.stringify(cond.value)})`;
  }
  const mode = cond.all ? "all" : "any";
  const children = (cond[mode] ?? [])
    .map(reconstructNestable)
    .join(",\n      ");
  return `${mode}(\n      ${children},\n    )`;
}

// ─── Outcome reconstruction ───────────────────────────────────────────────────

function resolvePipelineKey(
  params: Record<string, unknown> | null | undefined,
  definitionIdToKey: Map<string, string>,
  contextDesc: string,
): string {
  const pipelineDefinitionId = params?.["pipelineDefinitionId"] as
    string | undefined;
  const pipelineKey = params?.["pipelineKey"] as string | undefined;

  if (pipelineDefinitionId) {
    const key = definitionIdToKey.get(pipelineDefinitionId);
    if (!key) {
      throw new UnsupportedRuleError(
        `Cannot resolve pipelineDefinitionId "${pipelineDefinitionId}" to a pipeline key (${contextDesc}). ` +
          `Ensure the pipeline was pulled successfully.`,
      );
    }
    return key;
  }

  if (pipelineKey) return pipelineKey;

  throw new UnsupportedRuleError(
    `assign() event is missing pipelineDefinitionId and pipelineKey params (${contextDesc}).`,
  );
}

function reconstructOutcomeExpr(
  type: "assign" | "skip",
  params: Record<string, unknown> | null | undefined,
  definitionIdToKey: Map<string, string>,
  contextDesc: string,
): string {
  if (type === "skip") return "skip()";
  const key = resolvePipelineKey(params, definitionIdToKey, contextDesc);
  return `assign(${keyToVarName(key)})`;
}

// ─── Rule reconstruction ──────────────────────────────────────────────────────

function reconstructRuleExpr(
  rule: AssignmentPolicyRule,
  definitionIdToKey: Map<string, string>,
): string {
  const outcomeExpr = reconstructOutcomeExpr(
    rule.event.type as "assign" | "skip",
    rule.event.params ?? null,
    definitionIdToKey,
    "rule",
  );

  const mode = rule.conditions.all ? "all" : "any";
  const conditions = rule.conditions[mode] ?? [];

  // Single leaf condition: emit inline without wrapping all()/any()
  const firstCondition = conditions[0];
  if (
    mode === "all" &&
    conditions.length === 1 &&
    firstCondition !== undefined &&
    isLeafCondition(firstCondition)
  ) {
    return `${reconstructNestable(firstCondition)}.then(${outcomeExpr})`;
  }

  const nestableExprs = conditions.map(reconstructNestable).join(",\n      ");
  return `${mode}(\n      ${nestableExprs},\n    ).then(${outcomeExpr})`;
}

// ─── Import collection ────────────────────────────────────────────────────────

/**
 * Collect all pipeline keys that need to be imported as pipeline files.
 * Includes the default pipeline (if assign) and any assign() in rules.
 */
function collectImportedPipelineKeys(
  contract: DefaultPipelineAssignmentContract,
  definitionIdToKey: Map<string, string>,
): Set<string> {
  const keys = new Set<string>();

  // Default outcome
  if (contract.defaultEventType === "assign") {
    const key = resolvePipelineKey(
      contract.defaultEventParamsJson,
      definitionIdToKey,
      "default outcome",
    );
    keys.add(key);
  }

  // Rule outcomes
  for (const rule of contract.rulesJson.rules) {
    if (rule.event.type === "assign") {
      const id = rule.event.params?.["pipelineDefinitionId"] as
        string | undefined;
      const pKey = rule.event.params?.["pipelineKey"] as string | undefined;
      if (id) {
        const resolved = definitionIdToKey.get(id);
        if (resolved) keys.add(resolved);
      } else if (pKey) {
        keys.add(pKey);
      }
    }
  }

  return keys;
}

/**
 * Collect the names the generated `defaultPipelineAssignment(({ ... }) => ...)`
 * callback needs to destructure off its ctx parameter: some subset of
 * `assign`, `skip`, `all`, `any`, `workItem`, `context`.
 *
 * These are ctx-provided bindings, not module exports — `defaultPipelineAssignment`
 * is the only name this file imports from `@boboddy/sdk/definitions/pipelines`.
 * (A prior version of this function conflated the two and emitted an import
 * statement naming `workItem`/`assign`/etc., which don't exist as module
 * exports and fail to compile.)
 */
function collectCtxParamNames(
  contract: DefaultPipelineAssignmentContract,
): string[] {
  const names = new Set<string>();

  // default outcome
  if (contract.defaultEventType === "assign") names.add("assign");
  if (contract.defaultEventType === "skip") names.add("skip");

  const visitConditions = (conditions: SerializedConditionNode[]) => {
    for (const cond of conditions) {
      if (isLeafCondition(cond)) {
        if (cond.fact === WORK_ITEM_FACT) names.add("workItem");
        if (cond.fact === CONTEXT_FACT) names.add("context");
      } else {
        const mode = cond.all ? "all" : "any";
        names.add(mode);
        visitConditions(cond[mode] ?? []);
      }
    }
  };

  for (const rule of contract.rulesJson.rules) {
    if (rule.event.type === "skip") names.add("skip");
    if (rule.event.type === "assign") names.add("assign");

    const mode = rule.conditions.all ? "all" : "any";
    const conditions = rule.conditions[mode] ?? [];
    // Need all/any in ctx if the top-level has >1 condition or a nested group
    const firstCond = conditions[0];
    if (
      conditions.length > 1 ||
      (conditions.length === 1 &&
        firstCond !== undefined &&
        !isLeafCondition(firstCond))
    ) {
      names.add(mode);
    }
    visitConditions(conditions);
  }

  return [...names].sort();
}

// ─── Main file generator ──────────────────────────────────────────────────────

/**
 * Generate the content of `default-pipeline-assignment.ts` from the server
 * contract.
 *
 * @param contract          Server-side default pipeline assignment config.
 * @param definitionIdToKey Map from pipelineDefinitionId → pipeline key.
 *
 * @throws UnsupportedRuleError if the contract contains rules that cannot be
 *         reconstructed with the SDK's fluent DSL.
 */
export function generateDefaultPipelineAssignmentFileContent(
  contract: DefaultPipelineAssignmentContract,
  definitionIdToKey: Map<string, string>,
): string {
  const importedPipelineKeys = collectImportedPipelineKeys(
    contract,
    definitionIdToKey,
  );
  const ctxParts = collectCtxParamNames(contract);

  const lines: string[] = [];

  // `defaultPipelineAssignment` is the only module export this file needs —
  // `workItem`/`context`/`assign`/`skip`/`all`/`any` are ctx-destructured
  // parameter names, not exports, and must never appear in this import.
  lines.push(
    `import { defaultPipelineAssignment } from "@boboddy/sdk/definitions/pipelines";`,
  );

  // Pipeline default imports
  for (const key of importedPipelineKeys) {
    lines.push(`import ${keyToVarName(key)} from "./${key}";`);
  }
  lines.push("");

  const ctxParam =
    ctxParts.length > 0 ? `({ ${ctxParts.join(", ")} })` : `(_ctx)`;

  // Default outcome expression
  const defaultExpr = reconstructOutcomeExpr(
    contract.defaultEventType,
    contract.defaultEventParamsJson,
    definitionIdToKey,
    "default outcome",
  );

  // Rule expressions
  const ruleExprs = contract.rulesJson.rules.map((rule) =>
    reconstructRuleExpr(rule, definitionIdToKey),
  );

  // Assemble export
  lines.push(`export default defaultPipelineAssignment(${ctxParam} => ({`);
  lines.push(`  default: ${defaultExpr},`);
  if (ruleExprs.length === 0) {
    lines.push(`  rules: [],`);
  } else {
    lines.push(`  rules: [`);
    for (const expr of ruleExprs) {
      lines.push(`    ${expr},`);
    }
    lines.push(`  ],`);
  }
  lines.push(`}));`);

  return lines.join("\n") + "\n";
}
