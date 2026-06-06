import type { PipelineDefinitionSpec } from "./define-pipeline";

// ─── Reserved filename ────────────────────────────────────────────────────────

/**
 * The reserved filename for the default pipeline assignment file.
 * This file is NOT treated as a pipeline definition by the push scanner.
 */
export const DEFAULT_PIPELINE_ASSIGNMENT_FILENAME =
  "default-pipeline-assignment.ts";

// ─── Internal condition types ─────────────────────────────────────────────────

type ConditionOperator =
  | "equal"
  | "notEqual"
  | "lessThan"
  | "lessThanInclusive"
  | "greaterThan"
  | "greaterThanInclusive"
  | "in"
  | "notIn"
  | "contains"
  | "doesNotContain";

type LeafCondition = {
  readonly _tag: "leaf";
  /** Top-level fact name: "workItem" or "context". */
  readonly fact: string;
  /** JSONPath within the fact value, e.g. "$.fields.status". */
  readonly path?: string;
  readonly operator: ConditionOperator;
  readonly value: unknown;
};

type GroupCondition = {
  readonly _tag: "group";
  readonly mode: "all" | "any";
  readonly conditions: AssignmentCondition[];
};

type AssignmentCondition = LeafCondition | GroupCondition;

// ─── Outcomes ─────────────────────────────────────────────────────────────────

export type AssignOutcome = {
  readonly _tag: "assign";
  readonly pipeline: PipelineDefinitionSpec;
};

export type SkipOutcome = {
  readonly _tag: "skip";
};

export type DefaultPipelineAssignmentOutcome = AssignOutcome | SkipOutcome;

// ─── Rule ─────────────────────────────────────────────────────────────────────

export type AssignmentRule = {
  readonly _tag: "assignment_rule";
  readonly conditions: AssignmentCondition[];
  readonly mode: "all" | "any";
  readonly outcome: DefaultPipelineAssignmentOutcome;
};

// ─── Leaf and group interfaces ────────────────────────────────────────────────

/** A leaf condition; nestable in a group or terminable with `.then()`. */
export interface AssignmentLeaf {
  then(outcome: DefaultPipelineAssignmentOutcome): AssignmentRule;
  /** @internal */
  readonly _condition: AssignmentCondition;
}

/** A group condition (`all`/`any`); nestable or terminable with `.then()`. */
export interface AssignmentGroup {
  then(outcome: DefaultPipelineAssignmentOutcome): AssignmentRule;
  /** @internal */
  readonly _condition: AssignmentCondition;
}

type AssignmentNestable = AssignmentLeaf | AssignmentGroup;

function makeLeaf(
  fact: string,
  path: string | undefined,
  operator: ConditionOperator,
  value: unknown,
): AssignmentLeaf {
  const condition: LeafCondition = {
    _tag: "leaf",
    fact,
    ...(path ? { path } : {}),
    operator,
    value,
  };
  return {
    _condition: condition,
    then(outcome) {
      return { _tag: "assignment_rule", conditions: [condition], mode: "all", outcome };
    },
  };
}

// ─── Field ref ────────────────────────────────────────────────────────────────

/** Comparator-bound reference to a work-item field or context fact. */
export interface AssignmentFieldRef {
  eq(value: unknown): AssignmentLeaf;
  ne(value: unknown): AssignmentLeaf;
  gt(value: number): AssignmentLeaf;
  gte(value: number): AssignmentLeaf;
  lt(value: number): AssignmentLeaf;
  lte(value: number): AssignmentLeaf;
  in(values: ReadonlyArray<unknown>): AssignmentLeaf;
  notIn(values: ReadonlyArray<unknown>): AssignmentLeaf;
  contains(value: unknown): AssignmentLeaf;
  doesNotContain(value: unknown): AssignmentLeaf;
}

function makeFieldRef(fact: string, path?: string): AssignmentFieldRef {
  return {
    eq: (v) => makeLeaf(fact, path, "equal", v),
    ne: (v) => makeLeaf(fact, path, "notEqual", v),
    gt: (v) => makeLeaf(fact, path, "greaterThan", v),
    gte: (v) => makeLeaf(fact, path, "greaterThanInclusive", v),
    lt: (v) => makeLeaf(fact, path, "lessThan", v),
    lte: (v) => makeLeaf(fact, path, "lessThanInclusive", v),
    in: (vs) => makeLeaf(fact, path, "in", vs),
    notIn: (vs) => makeLeaf(fact, path, "notIn", vs),
    contains: (v) => makeLeaf(fact, path, "contains", v),
    doesNotContain: (v) => makeLeaf(fact, path, "doesNotContain", v),
  };
}

// ─── Context object ───────────────────────────────────────────────────────────

export type DefaultPipelineAssignmentCtx = {
  /**
   * Work-item field accessor.
   *
   * @example
   * workItem.field("issueType").eq("bug").then(assign(bugTriage))
   * workItem.field("labels").contains("regression").then(assign(regressionReview))
   * workItem.field("status").eq("resolved").then(skip())
   */
  workItem: {
    field(name: string): AssignmentFieldRef;
  };
  /**
   * Context facts for the current ingestion event.
   * `context.isNew` is `true` when the work item is being created for the first time.
   *
   * @example
   * context.isNew.eq(true).then(assign(onboarding))
   */
  context: {
    isNew: AssignmentFieldRef;
  };
  /**
   * Outcome: assign the work item to the given pipeline.
   * Used in both `rules` (via `.then(assign(...))`) and `default`.
   *
   * @example
   * workItem.field("issueType").eq("bug").then(assign(bugTriage))
   */
  assign(pipeline: PipelineDefinitionSpec): AssignOutcome;
  /**
   * Outcome: do not assign any pipeline to this work item.
   * Used in both `rules` (via `.then(skip())`) and `default`.
   *
   * @example
   * workItem.field("status").eq("resolved").then(skip())
   */
  skip(): SkipOutcome;
  /**
   * All nested conditions must match.
   *
   * @example
   * all(
   *   workItem.field("issueType").eq("bug"),
   *   workItem.field("priority").eq("high"),
   * ).then(assign(bugTriage))
   */
  all(...refs: AssignmentNestable[]): AssignmentGroup;
  /**
   * Any nested condition must match.
   *
   * @example
   * any(
   *   workItem.field("status").eq("resolved"),
   *   workItem.field("status").eq("closed"),
   * ).then(skip())
   */
  any(...refs: AssignmentNestable[]): AssignmentGroup;
};

// ─── Return type from the callback ───────────────────────────────────────────

export type DefaultPipelineAssignmentInput = {
  /**
   * The outcome when no rule matches. Use `assign(pipeline)` to assign a
   * specific pipeline, or `skip()` to do nothing.
   */
  default: DefaultPipelineAssignmentOutcome;
  /**
   * Ordered list of rules evaluated against each incoming work item.
   * First match wins; unmatched work items fall through to `default`.
   */
  rules: AssignmentRule[];
};

// ─── Spec (internal representation) ──────────────────────────────────────────

export type DefaultPipelineAssignmentSpec = {
  readonly _tag: "default_pipeline_assignment";
  readonly default: DefaultPipelineAssignmentOutcome;
  readonly rules: AssignmentRule[];
};

// ─── Context implementation ───────────────────────────────────────────────────

function makeAssign(pipeline: PipelineDefinitionSpec): AssignOutcome {
  if (
    typeof pipeline !== "object" ||
    pipeline === null ||
    typeof (pipeline as Record<string, unknown>)["key"] !== "string" ||
    !Array.isArray((pipeline as Record<string, unknown>)["steps"])
  ) {
    throw new Error(
      "assign() requires a pipeline spec produced by pipeline().build(). " +
        "Pass the default-exported value from a pipeline definition file.",
    );
  }
  return { _tag: "assign", pipeline };
}

function extractCondition(ref: AssignmentNestable): AssignmentCondition {
  return ref._condition;
}

function makeGroup(mode: "all" | "any", refs: AssignmentNestable[]): AssignmentGroup {
  const conditions = refs.map(extractCondition);
  const condition: GroupCondition = { _tag: "group", mode, conditions };
  return {
    _condition: condition,
    then(outcome) {
      return { _tag: "assignment_rule", conditions, mode, outcome };
    },
  };
}

function buildCtx(): DefaultPipelineAssignmentCtx {
  return {
    workItem: {
      field: (name: string) => makeFieldRef("workItem", `$.fields.${name}`),
    },
    context: {
      isNew: makeFieldRef("context", "$.isNew"),
    },
    assign: makeAssign,
    skip: () => ({ _tag: "skip" }),
    all: (...refs) => makeGroup("all", refs),
    any: (...refs) => makeGroup("any", refs),
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Define a default pipeline assignment policy for this project.
 *
 * Pass a callback that receives a context object with `workItem`, `context`,
 * `assign`, `skip`, `all`, and `any`. Return an object with `default` and
 * `rules`.
 *
 * `default` is the outcome when no rule matches — either `assign(pipeline)`
 * or `skip()`.
 *
 * `rules` is an ordered list; the first matching rule wins.
 *
 * @example
 * import bugTriage from "./bug-triage";
 * import { defaultPipelineAssignment } from "@boboddy/sdk/definitions/pipelines";
 *
 * export default defaultPipelineAssignment(({ workItem, any, assign, skip }) => ({
 *   default: assign(bugTriage),
 *   rules: [
 *     any(
 *       workItem.field("status").eq("resolved"),
 *       workItem.field("status").eq("manual support"),
 *     ).then(skip()),
 *     workItem.field("issueType").eq("bug").then(assign(bugTriage)),
 *   ],
 * }));
 */
export function defaultPipelineAssignment(
  callback: (ctx: DefaultPipelineAssignmentCtx) => DefaultPipelineAssignmentInput,
): DefaultPipelineAssignmentSpec {
  const input = callback(buildCtx());
  return {
    _tag: "default_pipeline_assignment",
    default: input.default,
    rules: input.rules,
  };
}

// ─── Serialization ────────────────────────────────────────────────────────────

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

type SerializedConditionNode = SerializedLeafCondition | SerializedConditionGroup;

type SerializedAssignmentRule = {
  conditions: SerializedConditionGroup;
  event: { type: string; params?: Record<string, unknown> };
};

export type SerializedDefaultPipelineAssignment = {
  /**
   * Pipeline key for the primary assign pipeline; resolved to a
   * `linearPipelineDefinitionId` by the push layer. Null when `default`
   * is `skip()` and no rule assigns a pipeline (push will reject this).
   */
  linearPipelineDefinitionKey: string;
  rulesJson: { rules: SerializedAssignmentRule[] };
  defaultEventType: "assign" | "skip";
  defaultEventParamsJson: Record<string, unknown> | null;
  allowedEventTypes: Array<"assign" | "skip">;
};

function serializeConditionNode(condition: AssignmentCondition): SerializedConditionNode {
  if (condition._tag === "leaf") {
    return {
      fact: condition.fact,
      ...(condition.path ? { path: condition.path } : {}),
      operator: condition.operator,
      value: condition.value,
    };
  }
  if (condition._tag === "group") {
    if (condition.mode === "all") {
      return { all: condition.conditions.map(serializeConditionNode) };
    }
    return { any: condition.conditions.map(serializeConditionNode) };
  }
  throw new Error(
    `Unknown condition tag: ${JSON.stringify((condition as Record<string, unknown>)["_tag"])}`,
  );
}

function serializeOutcome(outcome: DefaultPipelineAssignmentOutcome): {
  type: "assign" | "skip";
  params: Record<string, unknown> | null;
} {
  if (outcome._tag === "skip") return { type: "skip", params: null };
  return { type: "assign", params: { pipelineKey: outcome.pipeline.key } };
}

function serializeAssignmentRule(rule: AssignmentRule): SerializedAssignmentRule {
  const { type, params } = serializeOutcome(rule.outcome);
  return {
    conditions: { [rule.mode]: rule.conditions.map(serializeConditionNode) },
    event: { type, ...(params ? { params } : {}) },
  };
}

/**
 * Serialize a `DefaultPipelineAssignmentSpec` to the wire format.
 *
 * `linearPipelineDefinitionKey` is the key of the primary assign pipeline —
 * taken from `default` if it's `assign(...)`, otherwise from the first rule
 * that assigns a pipeline. The push layer rejects specs with no assign outcome.
 */
export function serializeDefaultPipelineAssignment(
  spec: DefaultPipelineAssignmentSpec,
): SerializedDefaultPipelineAssignment {
  // Find the primary pipeline key: the default assign pipeline, or the first
  // rule assign pipeline if default is skip().
  let primaryKey: string | null = null;
  if (spec.default._tag === "assign") {
    primaryKey = spec.default.pipeline.key;
  } else {
    for (const rule of spec.rules) {
      if (rule.outcome._tag === "assign") {
        primaryKey = rule.outcome.pipeline.key;
        break;
      }
    }
  }

  if (primaryKey === null) {
    throw new Error(
      "defaultPipelineAssignment must contain at least one assign() outcome " +
        "(in `default` or in `rules`). A policy that only skips is not useful.",
    );
  }

  const { type: defaultType, params: defaultParams } = serializeOutcome(spec.default);
  const outcomeSet = new Set<"assign" | "skip">([defaultType]);

  const serializedRules = spec.rules.map((rule) => {
    outcomeSet.add(serializeOutcome(rule.outcome).type);
    return serializeAssignmentRule(rule);
  });

  return {
    linearPipelineDefinitionKey: primaryKey,
    rulesJson: { rules: serializedRules },
    defaultEventType: defaultType,
    defaultEventParamsJson: defaultParams,
    allowedEventTypes: [...outcomeSet],
  };
}

/**
 * Type guard: returns true if `value` is a `DefaultPipelineAssignmentSpec`.
 */
export function isDefaultPipelineAssignmentSpec(
  value: unknown,
): value is DefaultPipelineAssignmentSpec {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)["_tag"] === "default_pipeline_assignment";
}
