import {
  type CohortAdvancementEventType,
  type CohortRule,
  type CohortRuleCondition,
  type CohortSignalCondition,
  type InlineStepSignalsListValue,
  type StepSignalsListConditionOperator,
  type StepSignalsListReducerOp,
  type StepSignalsListTransformOp,
} from "./cohort-advancement-policy";

// Deliberately distinct brand symbols from `fluent-rules.ts`'s own
// `LEAF_BRAND`/`GROUP_BRAND` (plain `Symbol()`, not the shared
// `Symbol.for()` registry that file uses) — `advanceEach`/`advanceAll`'s
// outcome domain (`continue`/`block` only, no `route`) and ctx shape
// (`branchOutcomes`/`stepSignalsList` instead of `stepSignals`/`route`)
// are genuinely different from a regular step's `.advance()`. `.then()`'s
// return type in particular must narrow to `CohortAdvancementEventType`
// (continue|block only — see `AdvanceEachCtx`'s doc comment and the AC4
// type-level tests in `pipeline-builder-fan-out.test.ts`), which the
// shared `fluent-rules.ts` machinery's `AdvancementOutcome`-typed
// `RuleLeaf`/`RuleGroup` can't express without widening it for every
// caller — hence a parallel, not reused, implementation here.
const LEAF_BRAND: unique symbol = Symbol("boboddy.cohortRule.leaf");
const GROUP_BRAND: unique symbol = Symbol("boboddy.cohortRule.group");

/**
 * A leaf condition + outcome attacher for the cohort scope
 * (`advanceEach`/`advanceAll`). Built by `signal(key).<op>(value)`,
 * `stepSignalsList.pluck(...).<reducer>()`, or `branchOutcomes.total()`/
 * `.count(...)` chained with a comparator. Nestable inside `all()`/`any()`,
 * or terminable with `.then(outcome)` — restricted to `continue`/`block`
 * (AC4: no `route`/`complete`, unlike a regular step's `RuleLeaf`).
 */
export interface CohortRuleLeaf {
  readonly [LEAF_BRAND]: CohortSignalCondition;
  then(
    outcome: CohortAdvancementEventType,
    paramsJson?: Record<string, unknown>,
  ): CohortRule;
}

/** A grouped condition + outcome attacher. Built by `all(...)` or `any(...)`. */
export interface CohortRuleGroup {
  readonly [GROUP_BRAND]: {
    mode: "all" | "any";
    conditions: CohortRuleCondition[];
  };
  then(
    outcome: CohortAdvancementEventType,
    paramsJson?: Record<string, unknown>,
  ): CohortRule;
}

type CohortNestable = CohortRuleLeaf | CohortRuleGroup;

/**
 * A comparator-bound reference into the cohort scope's facts — a branch's
 * own signal (`advanceEach`), a `branchOutcomes.total()`/`.count(outcome)`
 * aggregate, or a `stepSignalsList` reducer's result (`advanceAll`).
 * Calling any comparator produces a `CohortRuleLeaf`.
 */
export interface CohortSignalRef<TValue = unknown> {
  eq(value: TValue): CohortRuleLeaf;
  ne(value: TValue): CohortRuleLeaf;
  gt(value: number): CohortRuleLeaf;
  gte(value: number): CohortRuleLeaf;
  lt(value: number): CohortRuleLeaf;
  lte(value: number): CohortRuleLeaf;
  in(values: ReadonlyArray<TValue>): CohortRuleLeaf;
  notIn(values: ReadonlyArray<TValue>): CohortRuleLeaf;
  // eslint-disable-next-line local/no-unknown-parameter-type
  contains(value: unknown): CohortRuleLeaf;
  // eslint-disable-next-line local/no-unknown-parameter-type
  doesNotContain(value: unknown): CohortRuleLeaf;
}

function createCohortSignalRef(
  signal: string | InlineStepSignalsListValue,
): CohortSignalRef {
  const leaf = (
    operator: StepSignalsListConditionOperator,
    // eslint-disable-next-line local/no-unknown-parameter-type
    value: unknown,
  ): CohortRuleLeaf => {
    const condition: CohortSignalCondition = {
      _tag: "signal",
      signal,
      operator,
      value,
    };
    return {
      [LEAF_BRAND]: condition,
      then(outcome, paramsJson) {
        return {
          _tag: "rule",
          mode: "all",
          conditions: [condition],
          outcome,
          ...(paramsJson ? { outcomeJson: paramsJson } : {}),
        };
      },
    };
  };
  return {
    eq: (v) => leaf("equal", v),
    ne: (v) => leaf("notEqual", v),
    gt: (v) => leaf("greaterThan", v),
    gte: (v) => leaf("greaterThanInclusive", v),
    lt: (v) => leaf("lessThan", v),
    lte: (v) => leaf("lessThanInclusive", v),
    in: (vs) => leaf("in", vs),
    notIn: (vs) => leaf("notIn", vs),
    contains: (v) => leaf("contains", v),
    doesNotContain: (v) => leaf("doesNotContain", v),
  };
}

/** Directly builds a fully-formed leaf condition (`branchOutcomes.every`/`.some`). */
function createCohortLeafFromCondition(
  condition: CohortSignalCondition,
): CohortRuleLeaf {
  return {
    [LEAF_BRAND]: condition,
    then(outcome, paramsJson) {
      return {
        _tag: "rule",
        mode: "all",
        conditions: [condition],
        outcome,
        ...(paramsJson ? { outcomeJson: paramsJson } : {}),
      };
    },
  };
}

function extractCohortCondition(ref: CohortNestable): CohortRuleCondition {
  if (LEAF_BRAND in ref) return ref[LEAF_BRAND];
  const group = ref[GROUP_BRAND];
  return group.mode === "all"
    ? { _tag: "all", conditions: group.conditions }
    : { _tag: "any", conditions: group.conditions };
}

function createCohortGroup(
  mode: "all" | "any",
  refs: CohortNestable[],
): CohortRuleGroup {
  const conditions = refs.map(extractCohortCondition);
  return {
    [GROUP_BRAND]: { mode, conditions },
    then(outcome, paramsJson) {
      return {
        _tag: "rule",
        mode,
        conditions,
        outcome,
        ...(paramsJson ? { outcomeJson: paramsJson } : {}),
      };
    },
  };
}

// ─── advanceEach ────────────────────────────────────────────────────────────────

type SignalValue<
  TSignalKeys extends string,
  TSignalTypeMap extends Partial<Record<string, unknown>>,
  K extends TSignalKeys,
> = K extends keyof TSignalTypeMap ? TSignalTypeMap[K] : unknown;

/**
 * `advanceEach`'s callback context: one fan-out branch's own step result,
 * evaluated the same way a regular step's `.advance()` evaluates its own
 * signals (`evaluateBranchAgainstPolicy` — the same shared rules-engine
 * pass, just restricted to `continue`/`block`). No `route`/`complete`, and
 * — unlike `.advance()`'s `AdvanceCtx` — no `avg`/`sum`/`min`/`max`/`count`/
 * `booleanAny`/`booleanAll` computed-signal factories: core's `fanOut` node
 * config has no `computedSignalDefinitions` field to hoist them onto and
 * `evaluateBranchAgainstPolicy` never resolves them, so exposing them here
 * would silently produce dead wire fields. A later ticket can add that
 * support to core first, then extend this ctx to match.
 */
export interface AdvanceEachCtx<
  TSignalKeys extends string = string,
  TSignalTypeMap extends Partial<Record<string, unknown>> = Record<
    string,
    unknown
  >,
> {
  signal<K extends TSignalKeys>(
    key: K,
  ): CohortSignalRef<SignalValue<TSignalKeys, TSignalTypeMap, K>>;
  stepSignals: {
    [K in TSignalKeys]: CohortSignalRef<
      SignalValue<TSignalKeys, TSignalTypeMap, K>
    >;
  };
  all(...refs: CohortNestable[]): CohortRuleGroup;
  any(...refs: CohortNestable[]): CohortRuleGroup;
}

export interface AdvanceEachResult {
  default: CohortAdvancementEventType;
  rules?: CohortRule[];
}

function makeKeyedCohortSignalRef(key: string): CohortSignalRef {
  return createCohortSignalRef(key);
}

export function makeAdvanceEachCtx<
  TSignalKeys extends string,
  TSignalTypeMap extends Partial<Record<string, unknown>> = Record<
    string,
    unknown
  >,
>(): AdvanceEachCtx<TSignalKeys, TSignalTypeMap> {
  return {
    signal: (key) => makeKeyedCohortSignalRef(key),
    stepSignals: new Proxy(
      {} as Record<TSignalKeys, CohortSignalRef>,
      {
        get(_, key: string | symbol) {
          if (typeof key === "string")
            return makeKeyedCohortSignalRef(key);
          return undefined;
        },
      },
    ),
    all: (...refs) => createCohortGroup("all", refs),
    any: (...refs) => createCohortGroup("any", refs),
  };
}

// ─── advanceAll ─────────────────────────────────────────────────────────────────

/** The 4-value branch outcome classification (mirrors core's `branchOutcomeValues`). */
export const branchOutcomeValues = [
  "continue",
  "block",
  "error",
  "abandoned",
] as const;
export type BranchOutcome = (typeof branchOutcomeValues)[number];

/**
 * A `ctx.stepSignalsList`-derived op-list builder: seeded by `.pluck(key)`,
 * optionally narrowed/reshaped by `.filter()`/`.sortBy()`/`.unique()`, then
 * finalized by exactly one reducer into a comparator-bound
 * `CohortSignalRef` — the same "author fluently, hoist to a serializable
 * definition" shape `Computed.*` uses, but resolved server-side against a
 * cohort's real per-branch signals (`resolveStepSignalsListValue`) rather
 * than a single step's own signals.
 */
export interface StepSignalsListValueRef {
  filter(
    operator: StepSignalsListConditionOperator,
    // eslint-disable-next-line local/no-unknown-parameter-type
    value: unknown,
  ): StepSignalsListValueRef;
  sortBy(direction?: "asc" | "desc"): StepSignalsListValueRef;
  unique(): StepSignalsListValueRef;
  count(): CohortSignalRef;
  sum(): CohortSignalRef;
  avg(): CohortSignalRef;
  min(): CohortSignalRef;
  max(): CohortSignalRef;
  booleanAll(): CohortSignalRef;
  booleanAny(): CohortSignalRef;
  join(separator?: string): CohortSignalRef;
  first(): CohortSignalRef;
  last(): CohortSignalRef;
}

/** Summarizes a non-`pluck` transform op into a deterministic key fragment. */
function summarizeTransformOp(op: StepSignalsListTransformOp): string {
  if (op.op === "filter") {
    return `filter_${op.operator}_${JSON.stringify(op.value)}`;
  }
  if (op.op === "sortBy") {
    return `sortBy_${op.direction}`;
  }
  return "unique";
}

function deriveStepSignalsListKey(
  ops: readonly StepSignalsListTransformOp[],
  reducer: StepSignalsListReducerOp,
): string {
  const pluck = ops.find(
    (op): op is Extract<StepSignalsListTransformOp, { op: "pluck" }> =>
      op.op === "pluck",
  );
  const base = `${reducer.op}_${pluck?.signalKey ?? "value"}`;
  const extras = ops.filter((op) => op.op !== "pluck").map(summarizeTransformOp);
  const reducerExtra = reducer.op === "join" ? `sep_${reducer.separator}` : null;
  const suffixParts = [...extras, ...(reducerExtra ? [reducerExtra] : [])];
  return suffixParts.length > 0 ? `${base}_${suffixParts.join("_")}` : base;
}

function createStepSignalsListBuilder(
  ops: readonly StepSignalsListTransformOp[],
): StepSignalsListValueRef {
  const withOp = (op: StepSignalsListTransformOp) =>
    createStepSignalsListBuilder([...ops, op]);

  const reduce = (reducer: StepSignalsListReducerOp): CohortSignalRef => {
    const token: InlineStepSignalsListValue = {
      _tag: "step_signals_list",
      key: deriveStepSignalsListKey(ops, reducer),
      ops: [...ops],
      reducer,
    };
    return createCohortSignalRef(token);
  };

  return {
    filter: (operator, value) => withOp({ op: "filter", operator, value }),
    sortBy: (direction = "asc") => withOp({ op: "sortBy", direction }),
    unique: () => withOp({ op: "unique" }),
    count: () => reduce({ op: "count" }),
    sum: () => reduce({ op: "sum" }),
    avg: () => reduce({ op: "avg" }),
    min: () => reduce({ op: "min" }),
    max: () => reduce({ op: "max" }),
    booleanAll: () => reduce({ op: "booleanAll" }),
    booleanAny: () => reduce({ op: "booleanAny" }),
    join: (separator = ",") => reduce({ op: "join", separator }),
    first: () => reduce({ op: "first" }),
    last: () => reduce({ op: "last" }),
  };
}

/**
 * `advanceAll`'s callback context: the whole cohort's aggregate branch
 * outcomes (`branchOutcomes`) and any per-branch signal aggregation
 * (`stepSignalsList`) — evaluated exactly once per cohort
 * (`evaluateCohortAgainstPolicy`). Restricted to `continue`/`block`, no
 * `stepSignals`/`route` (this is a whole-cohort decision, not one step's
 * own).
 */
export interface AdvanceAllCtx {
  branchOutcomes: {
    /** The cohort's total branch count. Compiles to fact `branchCount`. */
    total(): CohortSignalRef<number>;
    /** A single outcome's count across the cohort. Compiles to fact `${outcome}Count`. */
    count(outcome: BranchOutcome): CohortSignalRef<number>;
    /** True iff every branch resolved to this outcome. */
    every(outcome: BranchOutcome): CohortRuleLeaf;
    /** True iff at least one branch resolved to this outcome. */
    some(outcome: BranchOutcome): CohortRuleLeaf;
  };
  stepSignalsList: {
    pluck(signalKey: string): StepSignalsListValueRef;
  };
  all(...refs: CohortNestable[]): CohortRuleGroup;
  any(...refs: CohortNestable[]): CohortRuleGroup;
}

export interface AdvanceAllResult {
  default: CohortAdvancementEventType;
  rules?: CohortRule[];
}

export function makeAdvanceAllCtx(): AdvanceAllCtx {
  return {
    branchOutcomes: {
      total: () => createCohortSignalRef("branchCount"),
      count: (outcome) => createCohortSignalRef(`${outcome}Count`),
      every: (outcome) =>
        createCohortLeafFromCondition({
          _tag: "signal",
          signal: `${outcome}Count`,
          operator: "equal",
          value: { fact: "branchCount" },
        }),
      some: (outcome) =>
        createCohortLeafFromCondition({
          _tag: "signal",
          signal: `${outcome}Count`,
          operator: "greaterThan",
          value: 0,
        }),
    },
    stepSignalsList: {
      pluck: (signalKey) =>
        createStepSignalsListBuilder([{ op: "pluck", signalKey }]),
    },
    all: (...refs) => createCohortGroup("all", refs),
    any: (...refs) => createCohortGroup("any", refs),
  };
}
