// ─── Cohort advancement policy (issue #167) ────────────────────────────────────
//
// `advanceEach` (per fan-out branch, on the `fanOut` node) and `advanceAll`
// (whole cohort, on the paired `cohortGate` node) share this narrower policy
// shape: restricted to `continue`/`block` (no `route`/`complete`), and no
// `allowedEventTypes` wrapper — mirrors the wire shape
// `CohortAdvancementPolicyDefinition` in
// `packages/core/.../pipeline-graph/domain/cohort-advancement-policy-definition.ts`.

/** Restricted outcome domain for both `advanceEach` and `advanceAll`. */
export const cohortAdvancementEventTypeValues = ["continue", "block"] as const;
export type CohortAdvancementEventType =
  (typeof cohortAdvancementEventTypeValues)[number];

// ─── ctx.stepSignalsList's op-list (issue #167) ────────────────────────────────
//
// Mirrors `Computed.*`/`InlineComputedSignal`'s "author fluently, hoist to a
// serializable definition, resolve server-side" shape, but the op-list is
// seeded from a fan-out cohort's per-branch signal values rather than a
// single step's own signals. Field-for-field compatible with core's
// `StepSignalsListDefinition` wire shape (the SDK has no dependency on
// `@boboddy/core`, so these are declared independently, not imported).
export type StepSignalsListConditionOperator =
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

export type StepSignalsListTransformOp =
  | { op: "pluck"; signalKey: string }
  | {
      op: "filter";
      operator: StepSignalsListConditionOperator;
      value: unknown;
    }
  | { op: "sortBy"; direction: "asc" | "desc" }
  | { op: "unique" };

export type StepSignalsListReducerOp =
  | { op: "count" }
  | { op: "sum" }
  | { op: "avg" }
  | { op: "min" }
  | { op: "max" }
  | { op: "booleanAll" }
  | { op: "booleanAny" }
  | { op: "join"; separator: string }
  | { op: "first" }
  | { op: "last" };

/** Wire-format `ctx.stepSignalsList`-derived value, hoisted onto the `cohortGate` node. */
export type SerializedStepSignalsListDefinition = {
  key: string;
  ops: StepSignalsListTransformOp[];
  reducer: StepSignalsListReducerOp;
};

/**
 * An inline `ctx.stepSignalsList`-derived token, embedded in a rule's
 * condition tree at the position a signal key would normally go. At
 * serialize time, hoisted into the `cohortGate` node's
 * `stepSignalsListDefinitions` and replaced by its bare `key` — the same
 * "author inline, hoist, replace with bare key" discipline
 * `extractInlineComputedSignals` already runs for `Computed.*`.
 */
export type InlineStepSignalsListValue<TKey extends string = string> = {
  readonly _tag: "step_signals_list";
  readonly key: TKey;
  readonly ops: StepSignalsListTransformOp[];
  readonly reducer: StepSignalsListReducerOp;
};

// ─── Conditions / rules ─────────────────────────────────────────────────────────

/**
 * A leaf condition, restricted to the cohort's own fact vocabulary: a bare
 * fact name (`branchOutcomes.total()`/`.count(outcome)`, or a
 * `ctx.stepSignalsList`-derived key) or an inline `InlineStepSignalsListValue`
 * token (hoisted at serialize time). `value` may itself be a dynamic
 * fact-reference (`{ fact: "branchCount" }`) — the same
 * json-rules-engine-native mechanism `branchOutcomes.every()` compiles to.
 */
export type CohortSignalCondition = {
  readonly _tag: "signal";
  signal: string | InlineStepSignalsListValue;
  operator: StepSignalsListConditionOperator;
  value: unknown;
};

export type CohortAllCondition = {
  readonly _tag: "all";
  conditions: CohortRuleCondition[];
};

export type CohortAnyCondition = {
  readonly _tag: "any";
  conditions: CohortRuleCondition[];
};

export type CohortRuleCondition =
  | CohortSignalCondition
  | CohortAllCondition
  | CohortAnyCondition;

export type CohortRule = {
  readonly _tag: "rule";
  mode: "all" | "any";
  conditions: CohortRuleCondition[];
  outcome: CohortAdvancementEventType;
  outcomeJson?: Record<string, unknown> | null;
};

// ─── Serialization ──────────────────────────────────────────────────────────────

export type SerializedCohortRule = {
  conditions: Record<string, unknown>;
  event: { type: CohortAdvancementEventType; params?: Record<string, unknown> };
};

/** Serialized shape expected by core's `CohortAdvancementPolicyDefinition`. */
export type SerializedCohortAdvancementPolicy = {
  rules: SerializedCohortRule[];
  defaultEventType: CohortAdvancementEventType;
  defaultEventParamsJson: Record<string, unknown> | null;
};

export type CohortAdvancementPolicy = {
  default: CohortAdvancementEventType;
  defaultParamsJson?: Record<string, unknown> | null;
  rules?: CohortRule[];
};

function serializeCohortCondition(
  condition: CohortRuleCondition,
): Record<string, unknown> {
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
    return { all: condition.conditions.map(serializeCohortCondition) };
  }
  return { any: condition.conditions.map(serializeCohortCondition) };
}

function serializeCohortRule(rule: CohortRule): SerializedCohortRule {
  return {
    conditions: { [rule.mode]: rule.conditions.map(serializeCohortCondition) },
    event: {
      type: rule.outcome,
      ...(rule.outcomeJson ? { params: rule.outcomeJson } : {}),
    },
  };
}

/** Serializes an authored `CohortAdvancementPolicy` (`advanceEach`/`advanceAll`) to its wire shape. */
export function serializeCohortAdvancementPolicy(
  policy: CohortAdvancementPolicy | undefined,
): SerializedCohortAdvancementPolicy {
  if (!policy) {
    return { rules: [], defaultEventType: "continue", defaultEventParamsJson: null };
  }
  return {
    rules: (policy.rules ?? []).map(serializeCohortRule),
    defaultEventType: policy.default,
    defaultEventParamsJson: policy.defaultParamsJson ?? null,
  };
}

// ─── Inline stepSignalsList extraction ──────────────────────────────────────────

function visitCohortSignalConditions(
  conditions: ReadonlyArray<CohortRuleCondition>,
  visit: (c: CohortSignalCondition) => void,
): void {
  for (const c of conditions) {
    if (c._tag === "signal") {
      visit(c);
    } else {
      visitCohortSignalConditions(c.conditions, visit);
    }
  }
}

function isSameStepSignalsListDefinition(
  a: SerializedStepSignalsListDefinition,
  b: SerializedStepSignalsListDefinition,
): boolean {
  return (
    JSON.stringify(a.ops) === JSON.stringify(b.ops) &&
    JSON.stringify(a.reducer) === JSON.stringify(b.reducer)
  );
}

/**
 * Walks a `CohortAdvancementPolicy`'s rules tree, extracts every inline
 * `ctx.stepSignalsList`-derived token embedded in a `CohortSignalCondition
 * .signal` position, dedupes by key, and returns the resulting
 * `stepSignalsListDefinitions` — the `cohortGate` node's counterpart to
 * `extractInlineComputedSignals`.
 */
export function extractInlineStepSignalsListDefinitions(
  policy: CohortAdvancementPolicy | undefined,
): SerializedStepSignalsListDefinition[] {
  if (!policy?.rules) return [];
  const byKey = new Map<string, SerializedStepSignalsListDefinition>();
  for (const rule of policy.rules) {
    visitCohortSignalConditions(rule.conditions, (cond) => {
      if (typeof cond.signal === "string") return;
      const inline = cond.signal;
      const def: SerializedStepSignalsListDefinition = {
        key: inline.key,
        ops: inline.ops,
        reducer: inline.reducer,
      };
      const existing = byKey.get(def.key);
      if (existing) {
        if (!isSameStepSignalsListDefinition(existing, def)) {
          throw new Error(
            `Conflicting inline stepSignalsList definitions for key "${def.key}"`,
          );
        }
        return;
      }
      byKey.set(def.key, def);
    });
  }
  return [...byKey.values()];
}
