import {
  Computed,
  type AdvancementOutcome,
  type ConditionOperator,
  type InlineComputedSignal,
  type Rule,
  type RuleCondition,
  type RouteOutcome,
  type SignalCondition,
} from "./define-advancement-policy";

const LEAF_BRAND: unique symbol = Symbol.for("boboddy.fluentRule.leaf");
const GROUP_BRAND: unique symbol = Symbol.for("boboddy.fluentRule.group");
const SIGNAL_KEY: unique symbol = Symbol.for("boboddy.fluentRule.signalKey");

/**
 * A leaf condition + outcome attacher. Built by `signal(key).<op>(value)` or
 * any computed factory chained with a comparator. Nestable inside `all()` /
 * `any()`, or terminable with `.then(outcome)`.
 */
export interface RuleLeaf<TSignalKeys extends string = string> {
  readonly [LEAF_BRAND]: SignalCondition<TSignalKeys>;
  then(outcome: AdvancementOutcome): Rule<TSignalKeys>;
}

/**
 * A grouped condition + outcome attacher. Built by `all(...)` or `any(...)`.
 * Nestable inside another group, or terminable with `.then(outcome)`.
 */
export interface RuleGroup<TSignalKeys extends string = string> {
  readonly [GROUP_BRAND]: {
    mode: "all" | "any";
    conditions: RuleCondition<TSignalKeys>[];
  };
  then(outcome: AdvancementOutcome): Rule<TSignalKeys>;
}

type Nestable<K extends string> = RuleLeaf<K> | RuleGroup<K>;

/**
 * A comparator-bound signal reference. Returned by `signal(key)` and by every
 * computed factory (`avg`, `sum`, etc.). Calling any comparator (`gte`, `eq`,
 * …) produces a `RuleLeaf`.
 *
 * `TValue` is the TypeScript type of the signal's value, enabling type-safe
 * comparisons (e.g. `eq(true)` errors when the signal is a string).
 */
export interface SignalRef<
  TSignalKeys extends string = string,
  TValue = unknown,
> {
  eq(value: TValue): RuleLeaf<TSignalKeys>;
  ne(value: TValue): RuleLeaf<TSignalKeys>;
  gt(value: number): RuleLeaf<TSignalKeys>;
  gte(value: number): RuleLeaf<TSignalKeys>;
  lt(value: number): RuleLeaf<TSignalKeys>;
  lte(value: number): RuleLeaf<TSignalKeys>;
  in(values: ReadonlyArray<TValue>): RuleLeaf<TSignalKeys>;
  notIn(values: ReadonlyArray<TValue>): RuleLeaf<TSignalKeys>;
  contains(value: unknown): RuleLeaf<TSignalKeys>;
  doesNotContain(value: unknown): RuleLeaf<TSignalKeys>;
}

/**
 * A `SignalRef` backed by a plain signal key (not a computed token). The
 * embedded `SIGNAL_KEY` brand lets computed factories extract the key at
 * runtime so callers can pass `stepSignals.foo` instead of the string `"foo"`.
 */
export interface KeyedSignalRef<
  TSignalKeys extends string = string,
  TValue = unknown,
> extends SignalRef<TSignalKeys, TValue> {
  readonly [SIGNAL_KEY]: TSignalKeys;
}

type ComputedTuple<K extends string, TValue = unknown> = [
  KeyedSignalRef<K, TValue>,
  KeyedSignalRef<K, TValue>,
  ...KeyedSignalRef<K, TValue>[],
];

// Resolves the value type for a signal key K given a signal type map.
type SignalValue<
  TSignalKeys extends string,
  TSignalTypeMap extends Partial<Record<string, unknown>>,
  K extends TSignalKeys,
> = K extends keyof TSignalTypeMap ? TSignalTypeMap[K] : unknown;

export interface AdvanceCtx<
  TSignalKeys extends string = string,
  TSignalTypeMap extends Partial<Record<string, unknown>> = Record<
    string,
    unknown
  >,
> {
  signal<K extends TSignalKeys>(
    key: K,
  ): KeyedSignalRef<TSignalKeys, SignalValue<TSignalKeys, TSignalTypeMap, K>>;
  stepSignals: {
    [K in TSignalKeys]: KeyedSignalRef<
      TSignalKeys,
      SignalValue<TSignalKeys, TSignalTypeMap, K>
    >;
  };
  avg(...args: ComputedTuple<TSignalKeys, number>): SignalRef<TSignalKeys>;
  weightedAvg(
    ...args: ComputedTuple<TSignalKeys, number>
  ): SignalRef<TSignalKeys>;
  sum(...args: ComputedTuple<TSignalKeys, number>): SignalRef<TSignalKeys>;
  min(...args: ComputedTuple<TSignalKeys, number>): SignalRef<TSignalKeys>;
  max(...args: ComputedTuple<TSignalKeys, number>): SignalRef<TSignalKeys>;
  count(...args: ComputedTuple<TSignalKeys>): SignalRef<TSignalKeys>;
  booleanAny(
    ...args: ComputedTuple<TSignalKeys, boolean>
  ): SignalRef<TSignalKeys>;
  booleanAll(
    ...args: ComputedTuple<TSignalKeys, boolean>
  ): SignalRef<TSignalKeys>;
  all(...refs: Nestable<TSignalKeys>[]): RuleGroup<TSignalKeys>;
  any(...refs: Nestable<TSignalKeys>[]): RuleGroup<TSignalKeys>;
  route(pipelineKey: string, inputJson?: Record<string, unknown>): RouteOutcome;
}

export interface AdvanceResult<TSignalKeys extends string = string> {
  default: AdvancementOutcome;
  rules?: Rule<TSignalKeys>[];
}

function createSignalRef<TSignalKeys extends string>(
  signal: TSignalKeys | InlineComputedSignal<string, TSignalKeys>,
): SignalRef<TSignalKeys> {
  const leaf = (
    operator: ConditionOperator,
    value: unknown,
  ): RuleLeaf<TSignalKeys> => {
    const condition: SignalCondition<TSignalKeys> = {
      _tag: "signal",
      signal,
      operator,
      value,
    };
    return {
      [LEAF_BRAND]: condition,
      then(outcome) {
        return {
          _tag: "rule",
          mode: "all",
          conditions: [condition],
          outcome,
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

function extractCondition<TSignalKeys extends string>(
  ref: Nestable<TSignalKeys>,
): RuleCondition<TSignalKeys> {
  if (LEAF_BRAND in ref) return ref[LEAF_BRAND];
  const group = ref[GROUP_BRAND];
  return group.mode === "all"
    ? { _tag: "all", conditions: group.conditions }
    : { _tag: "any", conditions: group.conditions };
}

function createGroup<TSignalKeys extends string>(
  mode: "all" | "any",
  refs: Nestable<TSignalKeys>[],
): RuleGroup<TSignalKeys> {
  const conditions = refs.map(extractCondition);
  return {
    [GROUP_BRAND]: { mode, conditions },
    then(outcome) {
      return { _tag: "rule", mode, conditions, outcome };
    },
  };
}

function resolveComputedArg<K extends string>(arg: KeyedSignalRef<K>): K {
  return (arg as Record<typeof SIGNAL_KEY, K>)[SIGNAL_KEY];
}

function makeKeyedSignalRef<TSignalKeys extends string>(
  key: TSignalKeys,
): KeyedSignalRef<TSignalKeys> {
  const ref = createSignalRef<TSignalKeys>(key);
  return Object.assign(ref, {
    [SIGNAL_KEY]: key,
  }) as KeyedSignalRef<TSignalKeys>;
}

export function makeAdvanceCtx<
  TSignalKeys extends string,
  TSignalTypeMap extends Partial<Record<string, unknown>> = Record<
    string,
    unknown
  >,
>(): AdvanceCtx<TSignalKeys, TSignalTypeMap> {
  type WideTuple = readonly [string, string, ...string[]];
  const wrapComputed = (
    token: InlineComputedSignal<string, string>,
  ): SignalRef<TSignalKeys> =>
    createSignalRef<TSignalKeys>(
      token as InlineComputedSignal<string, TSignalKeys>,
    );

  return {
    signal: (key) => makeKeyedSignalRef<TSignalKeys>(key),
    stepSignals: new Proxy(
      {} as Record<TSignalKeys, KeyedSignalRef<TSignalKeys>>,
      {
        get(_, key: string | symbol) {
          if (typeof key === "string")
            return makeKeyedSignalRef<TSignalKeys>(key as TSignalKeys);
          return undefined;
        },
      },
    ),
    avg: (...args) =>
      wrapComputed(
        Computed.average(args.map(resolveComputedArg) as unknown as WideTuple),
      ),
    weightedAvg: (...args) =>
      wrapComputed(
        Computed.weightedAverage(
          args.map(resolveComputedArg) as unknown as WideTuple,
        ),
      ),
    sum: (...args) =>
      wrapComputed(
        Computed.sum(args.map(resolveComputedArg) as unknown as WideTuple),
      ),
    min: (...args) =>
      wrapComputed(
        Computed.min(args.map(resolveComputedArg) as unknown as WideTuple),
      ),
    max: (...args) =>
      wrapComputed(
        Computed.max(args.map(resolveComputedArg) as unknown as WideTuple),
      ),
    count: (...args) =>
      wrapComputed(
        Computed.count(args.map(resolveComputedArg) as unknown as WideTuple),
      ),
    booleanAny: (...args) =>
      wrapComputed(
        Computed.booleanAny(
          args.map(resolveComputedArg) as unknown as WideTuple,
        ),
      ),
    booleanAll: (...args) =>
      wrapComputed(
        Computed.booleanAll(
          args.map(resolveComputedArg) as unknown as WideTuple,
        ),
      ),
    all: (...refs) => createGroup<TSignalKeys>("all", refs),
    any: (...refs) => createGroup<TSignalKeys>("any", refs),
    route: (pipelineKey, inputJson) =>
      inputJson !== undefined
        ? { outcome: "route", pipelineKey, inputJson }
        : { outcome: "route", pipelineKey },
  };
}
