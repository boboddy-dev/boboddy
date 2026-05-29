// ─── Computed signals ─────────────────────────────────────────────────────────

/** Aggregation types supported by the runtime for computed signals. */
export type PipelineStepComputedSignalType =
  | "average"
  | "weighted_average"
  | "sum"
  | "min"
  | "max"
  | "count"
  | "boolean_any"
  | "boolean_all";

// Joins a tuple of literal strings with a delimiter at the type level.
type Join<T extends readonly string[], D extends string> = T extends readonly [
  infer Head extends string,
  ...infer Rest extends readonly string[],
]
  ? Rest extends readonly []
    ? Head
    : `${Head}${D}${Join<Rest, D>}`
  : "";

/**
 * An inline computed-signal token returned by `Computed.X(...)`. Carries the
 * derived `key` (e.g. `"sum_success"`), the aggregation `type`, and the input
 * signal keys it aggregates over. At serialization time, every inline token
 * embedded in a rule's signal position is extracted into the step's
 * `computedSignalDefinitions` and replaced by its bare key string.
 *
 * - `TKey`             — the auto-derived key (literal template).
 * - `TInputSignalKeys` — the union of input signal keys; constrained to the
 *                        step's signals via `Rule.signal` / `Rule.when` typing.
 */
export type InlineComputedSignal<
  TKey extends string = string,
  TInputSignalKeys extends string = string,
> = {
  readonly _tag: "computed_signal";
  readonly key: TKey;
  readonly type: PipelineStepComputedSignalType;
  readonly inputSignalKeys: ReadonlyArray<TInputSignalKeys>;
  readonly configJson: Record<string, unknown> | null;
  readonly availableWhenResultStatusIn: readonly string[] | null;
};

type ComputedOptions = {
  configJson?: Record<string, unknown> | null;
  availableWhenResultStatusIn?: readonly string[] | null;
};

function makeComputed<
  TType extends PipelineStepComputedSignalType,
  const TInputs extends readonly [string, string, ...string[]],
>(
  type: TType,
  inputSignalKeys: TInputs,
  options?: ComputedOptions,
): InlineComputedSignal<`${TType}_${Join<TInputs, "_">}`, TInputs[number]> {
  const key = [type, ...inputSignalKeys].join(
    "_",
  ) as `${TType}_${Join<TInputs, "_">}`;
  return {
    _tag: "computed_signal",
    key,
    type,
    inputSignalKeys,
    configJson: options?.configJson ?? null,
    availableWhenResultStatusIn: options?.availableWhenResultStatusIn ?? null,
  };
}

/**
 * Factories for inline computed signals. Each call returns a token whose `key`
 * is auto-derived as `${type}_${inputSignalKeys.join("_")}`.
 *
 * @example
 * Rule.when(Computed.sum(["success"]), "greaterThan", 1, "continue")
 * Rule.signal(Computed.average(["score"]), "greaterThanInclusive", 80)
 *
 * For new code, prefer the equivalent factories on the `.advance()` callback
 * context of the `pipeline()` builder (`avg`, `sum`, `min`, `max`, …) — they
 * return chainable `SignalRef`s and infer signal keys from the current step.
 */
export const Computed = {
  average: <const TInputs extends readonly [string, string, ...string[]]>(
    inputSignalKeys: TInputs,
    options?: ComputedOptions,
  ) => makeComputed("average", inputSignalKeys, options),
  weightedAverage: <const TInputs extends readonly [string, string, ...string[]]>(
    inputSignalKeys: TInputs,
    options?: ComputedOptions,
  ) => makeComputed("weighted_average", inputSignalKeys, options),
  sum: <const TInputs extends readonly [string, string, ...string[]]>(
    inputSignalKeys: TInputs,
    options?: ComputedOptions,
  ) => makeComputed("sum", inputSignalKeys, options),
  min: <const TInputs extends readonly [string, string, ...string[]]>(
    inputSignalKeys: TInputs,
    options?: ComputedOptions,
  ) => makeComputed("min", inputSignalKeys, options),
  max: <const TInputs extends readonly [string, string, ...string[]]>(
    inputSignalKeys: TInputs,
    options?: ComputedOptions,
  ) => makeComputed("max", inputSignalKeys, options),
  count: <const TInputs extends readonly [string, string, ...string[]]>(
    inputSignalKeys: TInputs,
    options?: ComputedOptions,
  ) => makeComputed("count", inputSignalKeys, options),
  booleanAny: <const TInputs extends readonly [string, string, ...string[]]>(
    inputSignalKeys: TInputs,
    options?: ComputedOptions,
  ) => makeComputed("boolean_any", inputSignalKeys, options),
  booleanAll: <const TInputs extends readonly [string, string, ...string[]]>(
    inputSignalKeys: TInputs,
    options?: ComputedOptions,
  ) => makeComputed("boolean_all", inputSignalKeys, options),
} as const;

// ─── Operators ────────────────────────────────────────────────────────────────

/**
 * Comparison operators supported by json-rules-engine.
 * These map directly to the operator names the runtime evaluates against signal values.
 */
export type ConditionOperator =
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

// ─── Outcome ──────────────────────────────────────────────────────────────────

/** All possible outcomes a step can resolve to after policy evaluation. */
export type AdvancementEventType =
  | "continue"
  | "block"
  | "route"
  | "complete";

export type RouteOutcome = {
  outcome: "route";
  pipelineKey: string;
  inputJson?: Record<string, unknown> | null;
};

/**
 * The outcome emitted when a rule fires (or when no rules match and
 * `defaultOutcome` is used).
 *
 * Shorthand — use when no extra params are needed:
 *   "continue"
 *
 * Route to another pipeline:
 *   { outcome: "route", pipelineKey: "other-pipeline" }
 */
export type AdvancementOutcome =
  | Exclude<AdvancementEventType, "route">
  | RouteOutcome;

// ─── Conditions ───────────────────────────────────────────────────────────────

/**
 * A leaf condition that checks a single signal value against a given operator
 * and value. Used directly inside `Rule.all()` / `Rule.any()`, or implicitly
 * by `Rule.when()`.
 *
 * `TSignalKeys` is constrained to the declaring step's signal keys, so the
 * `signal` field is validated at compile time. `signal` may be either a step
 * signal key (string) or an inline `Computed.X(...)` token — at serialization
 * time, inline tokens are hoisted into `computedSignalDefinitions` and replaced
 * by their bare key string.
 */
export type SignalCondition<TSignalKeys extends string = string> = {
  readonly _tag: "signal";
  signal: TSignalKeys | InlineComputedSignal<string, TSignalKeys>;
  operator: ConditionOperator;
  value: unknown;
};

/**
 * A condition group where ALL nested conditions must match.
 * Created by calling `Rule.all()` without an outcome argument.
 * Can itself be nested inside another `Rule.all()` or `Rule.any()`.
 */
export type AllCondition<TSignalKeys extends string = string> = {
  readonly _tag: "all";
  conditions: RuleCondition<TSignalKeys>[];
};

/**
 * A condition group where ANY nested condition must match.
 * Created by calling `Rule.any()` without an outcome argument.
 * Can itself be nested inside another `Rule.all()` or `Rule.any()`.
 */
export type AnyCondition<TSignalKeys extends string = string> = {
  readonly _tag: "any";
  conditions: RuleCondition<TSignalKeys>[];
};

/**
 * Anything that can appear inside `Rule.all()` or `Rule.any()` — either a leaf
 * signal condition or a nested all/any group.
 */
export type RuleCondition<TSignalKeys extends string = string> =
  | SignalCondition<TSignalKeys>
  | AllCondition<TSignalKeys>
  | AnyCondition<TSignalKeys>;

// ─── Rule ─────────────────────────────────────────────────────────────────────

/**
 * A complete advancement rule: one or more conditions evaluated in `all` or
 * `any` mode, plus the outcome emitted when the rule fires.
 *
 * Rules are created via the `Rule` namespace — `Rule.when()`, `Rule.all()`,
 * `Rule.any()`. They are not constructed directly.
 */
export type Rule<TSignalKeys extends string = string> = {
  readonly _tag: "rule";
  mode: "all" | "any";
  conditions: RuleCondition<TSignalKeys>[];
  outcome: AdvancementOutcome;
};

// ─── Rule namespace ───────────────────────────────────────────────────────────

/**
 * Creates a leaf signal condition for use inside `Rule.all()` or `Rule.any()`.
 * Not a rule itself — no outcome is attached.
 *
 * @example
 * Rule.all([
 *   Rule.signal("score", "greaterThanInclusive", 80),
 *   Rule.signal("flagged", "equal", false),
 * ], "continue")
 */
function signal<TSignalKeys extends string>(
  signal: TSignalKeys | InlineComputedSignal<string, TSignalKeys>,
  operator: ConditionOperator,
  value: unknown,
): SignalCondition<TSignalKeys> {
  return { _tag: "signal", signal, operator, value };
}

/**
 * When called with only `conditions`: returns a nested `AllCondition` group
 * for use inside another `Rule.all()` or `Rule.any()`.
 *
 * When called with `conditions` and `outcome`: returns a top-level `Rule` that
 * fires when ALL conditions match.
 *
 * @example
 * // Top-level rule
 * Rule.all([Rule.signal("passed", "equal", true)], "continue")
 *
 * // Nested inside Rule.any
 * Rule.any([
 *   Rule.all([
 *     Rule.signal("score", "greaterThan", 90),
 *     Rule.signal("flagged", "equal", false),
 *   ]),
 *   Rule.signal("override", "equal", true),
 * ], "continue")
 */
function all<TSignalKeys extends string>(
  conditions: RuleCondition<TSignalKeys>[],
): AllCondition<TSignalKeys>;
function all<TSignalKeys extends string>(
  conditions: RuleCondition<TSignalKeys>[],
  outcome: AdvancementOutcome,
): Rule<TSignalKeys>;
function all<TSignalKeys extends string>(
  conditions: RuleCondition<TSignalKeys>[],
  outcome?: AdvancementOutcome,
): AllCondition<TSignalKeys> | Rule<TSignalKeys> {
  if (outcome === undefined) {
    return { _tag: "all", conditions };
  }
  return { _tag: "rule", mode: "all", conditions, outcome };
}

/**
 * When called with only `conditions`: returns a nested `AnyCondition` group
 * for use inside another `Rule.all()` or `Rule.any()`.
 *
 * When called with `conditions` and `outcome`: returns a top-level `Rule` that
 * fires when ANY condition matches.
 *
 * @example
 * // Top-level rule
 * Rule.any([
 *   Rule.signal("score", "greaterThan", 90),
 *   Rule.signal("override", "equal", true),
 * ], "continue")
 *
 * // Nested inside Rule.all
 * Rule.all([
 *   Rule.signal("score", "greaterThanInclusive", 80),
 *   Rule.any([
 *     Rule.signal("reviewerApproved", "equal", true),
 *     Rule.signal("autoApproved", "equal", true),
 *   ]),
 * ], "continue")
 */
function any<TSignalKeys extends string>(
  conditions: RuleCondition<TSignalKeys>[],
): AnyCondition<TSignalKeys>;
function any<TSignalKeys extends string>(
  conditions: RuleCondition<TSignalKeys>[],
  outcome: AdvancementOutcome,
): Rule<TSignalKeys>;
function any<TSignalKeys extends string>(
  conditions: RuleCondition<TSignalKeys>[],
  outcome?: AdvancementOutcome,
): AnyCondition<TSignalKeys> | Rule<TSignalKeys> {
  if (outcome === undefined) {
    return { _tag: "any", conditions };
  }
  return { _tag: "rule", mode: "any", conditions, outcome };
}

/**
 * Shorthand for a single-condition rule. Equivalent to
 * `Rule.all([Rule.signal(signal, operator, value)], outcome)`.
 *
 * @example
 * Rule.when("passed", "equal", true, "continue")
 * Rule.when("score", "greaterThanInclusive", 80, { outcome: "continue", outcomeJson: { via: "score" } })
 */
function when<TSignalKeys extends string>(
  signal: TSignalKeys | InlineComputedSignal<string, TSignalKeys>,
  operator: ConditionOperator,
  value: unknown,
  outcome: AdvancementOutcome,
): Rule<TSignalKeys> {
  return {
    _tag: "rule",
    mode: "all",
    conditions: [{ _tag: "signal", signal, operator, value }],
    outcome,
  };
}

/**
 * All factories for building advancement rules.
 *
 * - `Rule.signal` — leaf condition (used inside `all` / `any`)
 * - `Rule.all`    — all conditions must match; nestable
 * - `Rule.any`    — any condition must match; nestable
 * - `Rule.when`   — shorthand for a single-signal rule
 */
export const Rule = { signal, all, any, when } as const;

// ─── Policy ───────────────────────────────────────────────────────────────────

/**
 * Controls when and how a pipeline step advances.
 *
 * Rules are evaluated in order; the first match wins. If no rule fires,
 * the step resolves to `defaultOutcome`.
 *
 * `TSignalKeys` is inferred from the step's declared signals, which constrains
 * all `Rule.signal()` / `Rule.when()` calls to only valid signal keys.
 *
 * @example
 * {
 *   defaultOutcome: "block",
 *   rules: [
 *     Rule.when("passed", "equal", true, "continue"),
 *     Rule.all([
 *       Rule.signal("score", "greaterThanInclusive", 80),
 *       Rule.any([
 *         Rule.signal("reviewerApproved", "equal", true),
 *         Rule.signal("autoApproved", "equal", true),
 *       ]),
 *     ], "continue"),
 *   ],
 * }
 */
export type AdvancementPolicy<TSignalKeys extends string = string> = {
  /**
   * The outcome emitted when no rule matches.
   * "continue" — step advances automatically.
   * "block"    — step waits for human intervention.
   */
  defaultOutcome: AdvancementOutcome;
  /**
   * Ordered list of rules evaluated against the step's signal values.
   * First match wins; unmatched falls through to `defaultOutcome`.
   */
  rules?: Rule<TSignalKeys>[];
};

// ─── Serialization ────────────────────────────────────────────────────────────

// Internal types matching the json-rules-engine wire format.

type SerializedLeafCondition = {
  fact: string;
  operator: string;
  value: unknown;
};

type SerializedConditionGroup = {
  all?: SerializedCondition[];
  any?: SerializedCondition[];
};

type SerializedCondition = SerializedLeafCondition | SerializedConditionGroup;

type SerializedRule = {
  conditions: SerializedConditionGroup;
  event: { type: string; params?: Record<string, unknown> };
};

/** Serialized shape expected by the boboddy runtime API. */
export type SerializedAdvancementPolicy = {
  rulesJson: { rules: SerializedRule[] };
  defaultEventType: AdvancementEventType;
  defaultEventParamsJson: Record<string, unknown> | null;
  allowedEventTypes: AdvancementEventType[];
};

function resolveOutcome(outcome: AdvancementOutcome): {
  type: AdvancementEventType;
  params: Record<string, unknown> | null;
} {
  if (typeof outcome === "string") {
    return { type: outcome, params: null };
  }
  return {
    type: "route",
    params: {
      pipelineKey: outcome.pipelineKey,
      ...(outcome.inputJson != null ? { inputJson: outcome.inputJson } : {}),
    },
  };
}

function serializeCondition(condition: RuleCondition): SerializedCondition {
  if (condition._tag === "signal") {
    return {
      fact:
        typeof condition.signal === "string"
          ? condition.signal
          : condition.signal.key,
      operator: condition.operator,
      value: condition.value,
    };
  }
  if (condition._tag === "all") {
    return { all: condition.conditions.map(serializeCondition) };
  }
  return { any: condition.conditions.map(serializeCondition) };
}

function serializeRule(rule: Rule): SerializedRule {
  const resolved = resolveOutcome(rule.outcome);
  return {
    conditions: { [rule.mode]: rule.conditions.map(serializeCondition) },
    event: {
      type: resolved.type,
      ...(resolved.params ? { params: resolved.params } : {}),
    },
  };
}

export function serializeAdvancementPolicy(
  policy: AdvancementPolicy | undefined,
): SerializedAdvancementPolicy {
  if (!policy) {
    return {
      rulesJson: { rules: [] },
      defaultEventType: "continue",
      defaultEventParamsJson: null,
      allowedEventTypes: ["continue"],
    };
  }

  const defaultResolved = resolveOutcome(policy.defaultOutcome);
  const outcomeSet = new Set<AdvancementEventType>([defaultResolved.type]);

  const serializedRules = (policy.rules ?? []).map((rule) => {
    outcomeSet.add(resolveOutcome(rule.outcome).type);
    return serializeRule(rule);
  });

  return {
    rulesJson: { rules: serializedRules },
    defaultEventType: defaultResolved.type,
    defaultEventParamsJson: defaultResolved.params,
    allowedEventTypes: [...outcomeSet],
  };
}

// ─── Inline computed signal extraction ────────────────────────────────────────

/** Wire-format computed signal definition emitted on the pipeline step. */
export type SerializedComputedSignalDefinition = {
  key: string;
  type: PipelineStepComputedSignalType;
  inputSignalKeys: string[];
  configJson: Record<string, unknown> | null;
  availableWhenResultStatusIn: string[] | null;
};

function visitSignalConditions(
  conditions: ReadonlyArray<RuleCondition>,
  visit: (c: SignalCondition) => void,
): void {
  for (const c of conditions) {
    if (c._tag === "signal") {
      visit(c);
    } else {
      visitSignalConditions(c.conditions, visit);
    }
  }
}

function isSameComputedDefinition(
  a: SerializedComputedSignalDefinition,
  b: SerializedComputedSignalDefinition,
): boolean {
  return (
    a.type === b.type &&
    a.inputSignalKeys.length === b.inputSignalKeys.length &&
    a.inputSignalKeys.every((k, i) => k === b.inputSignalKeys[i]) &&
    JSON.stringify(a.configJson) === JSON.stringify(b.configJson) &&
    JSON.stringify(a.availableWhenResultStatusIn) ===
      JSON.stringify(b.availableWhenResultStatusIn)
  );
}

/**
 * Walks the rules tree, extracts every inline `Computed.X(...)` token embedded
 * in a `SignalCondition.signal` position, dedupes by key, and returns the
 * resulting computed-signal definitions. Two tokens with the same key but
 * differing definitions are a programming error and throw.
 */
export function extractInlineComputedSignals(
  policy: AdvancementPolicy | undefined,
): SerializedComputedSignalDefinition[] {
  if (!policy?.rules) return [];
  const byKey = new Map<string, SerializedComputedSignalDefinition>();
  for (const rule of policy.rules) {
    visitSignalConditions(rule.conditions, (cond) => {
      if (typeof cond.signal === "string") return;
      const inline = cond.signal;
      const def: SerializedComputedSignalDefinition = {
        key: inline.key,
        type: inline.type,
        inputSignalKeys: [...inline.inputSignalKeys],
        configJson: inline.configJson,
        availableWhenResultStatusIn: inline.availableWhenResultStatusIn
          ? [...inline.availableWhenResultStatusIn]
          : null,
      };
      const existing = byKey.get(def.key);
      if (existing) {
        if (!isSameComputedDefinition(existing, def)) {
          throw new Error(
            `Conflicting inline computed signal definitions for key "${def.key}"`,
          );
        }
        return;
      }
      byKey.set(def.key, def);
    });
  }
  return [...byKey.values()];
}
