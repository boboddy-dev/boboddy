---
title: Pipeline Advancement
description: Decide whether a pipeline continues, blocks, or routes elsewhere using advancement policies and computed signals
---

The `advance` option in a step's `.step(step, options)` call attaches an advancement policy to that step — it's required on every step. See [Building Pipelines](/boboddy/guides/pipelines/) for the `pipeline()` builder itself.

## Advancement policies

`options.advance` attaches a policy to the step. The callback receives a context with `signal`, `all`, `any`, `route`, and every computed-signal factory. The signal keys are typed against that step.

```typescript
.step(reviewCodeStep, {
  input: ({ input }) => ({ code: input.code }),
  advance: ({ signal }) => ({
    default: "block",
    rules: [signal("clarity_score").gt(7).then("continue")],
  }),
})
```

If the default outcome is `"block"` and no rule fires, the pipeline halts at that step and marks the execution as needing review.

### Comparators on `SignalRef`

| Method               | Wire operator           |
| -------------------- | ----------------------- |
| `.eq(value)`         | `equal`                 |
| `.ne(value)`         | `notEqual`              |
| `.gt(n)`             | `greaterThan`           |
| `.gte(n)`            | `greaterThanInclusive`  |
| `.lt(n)`             | `lessThan`              |
| `.lte(n)`            | `lessThanInclusive`     |
| `.in(values)`        | `in`                    |
| `.notIn(values)`     | `notIn`                 |
| `.contains(value)`   | `contains`              |
| `.doesNotContain(v)` | `doesNotContain`        |

Each returns a `RuleLeaf`. Call `.then(outcome)` to finalize as a rule, or pass it into `all(...)` / `any(...)` to nest.

### Grouping with `all` and `any`

```typescript
advance: ({ signal, all, any }) => ({
  default: "block",
  rules: [
    all(
      signal("clarity_score").gte(7),
      any(
        signal("reviewer_approved").eq(true),
        signal("auto_approved").eq(true),
      ),
    ).then("continue"),
  ],
}),
```

Groups are nestable arbitrarily. Each `.then(outcome)` closes the rule.

### Routing to another pipeline

```typescript
advance: ({ signal, route }) => ({
  default: "complete",
  rules: [
    signal("flagged").eq(true).then(route("triage-pipeline", { reason: "flagged" })),
  ],
}),
```

## Computed signals

Computed signals aggregate multiple raw signals into a derived value inline. The factories live on the same `advance` context — no separate declaration on the step required.

```typescript
advance: ({ avg, signal, stepSignals }) => ({
  default: "block",
  rules: [
    avg(stepSignals.quality_score, stepSignals.security_score).gte(7).then("continue"),
    signal("flagged").eq(true).then("block"),
  ],
}),
```

### Available factories

| Method                   | Description                                       | Input signal types |
| ------------------------ | ------------------------------------------------- | ------------------ |
| `avg(...keys)`           | Arithmetic mean of the input signals              | `number`           |
| `weightedAvg(...keys)`   | Weighted mean (pass weights via configJson later) | `number`           |
| `sum(...keys)`           | Sum of the input signals                          | `number`           |
| `min(...keys)`           | Minimum value across the input signals            | `number`           |
| `max(...keys)`           | Maximum value across the input signals            | `number`           |
| `count(...keys)`         | Count of truthy or present signal values          | `any`              |
| `booleanAny(...keys)`    | `true` if any input signal is truthy              | `boolean`          |
| `booleanAll(...keys)`    | `true` only if all input signals are truthy       | `boolean`          |

Each factory requires **at least two** signal keys. The same call across multiple rules is deduplicated into a single computed-signal definition at build time.

## Fan-out cohort advancement: `advance` / `advanceAll`

A [fan-out](/boboddy/guides/pipelines/#fan-out-parallel-branches) (`.fanOutStep(step, config)`) runs a step as N parallel branches, and needs two advancement decisions instead of one: each branch's own outcome (`advance`), then the whole cohort's outcome once every branch has settled (`advanceAll`). Both are keys inside `.fanOutStep()`'s single `config` object — not chained method calls — and both are restricted to a narrower `"continue" | "block"` outcome domain — no `route`/`complete`, since a fan-out branch or cohort can't redirect the pipeline to a different one.

```typescript
.fanOutStep(reviewStep, {
  over: "reviewer_count",
  advance: ({ signal }) => ({
    default: "continue",
    rules: [signal("passed").eq(false).then("block")],
  }),
  advanceAll: ({ branchOutcomes }) => ({
    default: "block",
    rules: [branchOutcomes.every("continue").then("continue")],
  }),
})
```

### `advance` — one branch's own outcome

Evaluated per-branch against that branch's own signals, the same way a regular step's `advance` option evaluates its signals. The callback context provides `signal(key)`, `stepSignals.<key>`, `all(...)`, and `any(...)` — no computed-signal factories (`avg`, `sum`, etc.), since core has no mechanism yet to resolve a computed signal against a fan-out branch's policy.

```typescript
advance: ({ signal, all }) => ({
  default: "continue",
  rules: [
    all(signal("confidence").lt(0.5), signal("passed").eq(false)).then("block"),
  ],
}),
```

### `advanceAll` — the whole cohort's outcome

Evaluated once per cohort, after every branch has resolved to an outcome. The callback context provides `branchOutcomes`, `stepSignalsList`, `all(...)`, and `any(...)`.

#### `branchOutcomes`

| Method                | Description                                                     |
| --------------------- | ----------------------------------------------------------------- |
| `.total()`            | The cohort's total branch count (fact `branchCount`)             |
| `.count(outcome)`     | A single outcome's count across the cohort (fact `${outcome}Count`) |
| `.every(outcome)`     | `true` iff every branch resolved to this outcome                  |
| `.some(outcome)`      | `true` iff at least one branch resolved to this outcome           |

`outcome` is one of `"continue" | "block" | "error" | "abandoned"` — the 4-value branch outcome classification (`error`/`abandoned` cover branches that failed or never ran, and can't be produced by `advance` itself). `.total()` and `.count()` return a `CohortSignalRef` — chain a comparator (`.eq`, `.gt`, `.gte`, etc., same as a regular `SignalRef`) and `.then(outcome)` to finalize. `.every()`/`.some()` are already booleans — go straight to `.then(outcome)`.

```typescript
advanceAll: ({ branchOutcomes, all }) => ({
  default: "block",
  rules: [
    all(
      branchOutcomes.total().gte(1),
      branchOutcomes.count("block").eq(0),
    ).then("continue"),
    branchOutcomes.some("error").then("block"),
  ],
}),
```

#### `stepSignalsList`

Aggregates a signal across every branch in the cohort — the fan-out counterpart to a regular step's computed signals. Seed with `.pluck(signalKey)`, optionally reshape with `.filter(operator, value)` / `.sortBy(direction?)` / `.unique()`, then finalize with exactly one reducer:

| Reducer         | Description                                  |
| ---------------- | ----------------------------------------------- |
| `.count()`       | Number of values                                |
| `.sum()`         | Sum of numeric values                           |
| `.avg()`         | Arithmetic mean of numeric values                |
| `.min()`         | Minimum value                                    |
| `.max()`         | Maximum value                                    |
| `.booleanAll()`  | `true` only if every value is truthy             |
| `.booleanAny()`  | `true` if any value is truthy                    |
| `.join(sep?)`    | Joins values into a string (default separator `,`) |
| `.first()`       | The first value                                  |
| `.last()`        | The last value                                   |

Each reducer returns a `CohortSignalRef` — chain a comparator and `.then(outcome)` the same as `branchOutcomes`.

```typescript
advanceAll: ({ stepSignalsList }) => ({
  default: "continue",
  rules: [
    stepSignalsList
      .pluck("confidence")
      .filter("greaterThanInclusive", 0.5)
      .unique()
      .count()
      .lt(1)
      .then("block"),
  ],
}),
```

## Multi-step pipeline example

```typescript
import { pipeline } from "@boboddy/sdk/definitions/pipelines";
import { z } from "zod";
import { reviewCodeStep, refactorStep, verifyStep } from "./steps";

export default pipeline({
  key: "full-review",
  name: "Full Code Review Pipeline",
  status: "active",
  additionalPipelineInput: {
    schema: z.object({ code: z.string() }),
    bindings: ({ workItem }) => ({
      code: workItem.field("Code"),
    }),
  },
})
  .step(reviewCodeStep, {
    input: ({ input }) => ({
      code: input.code,
    }),
    advance: ({ signal }) => ({
      default: "block",
      rules: [signal("clarity_score").gt(6).then("continue")],
    }),
  })
  .step(refactorStep, {
    input: ({ input, output }) => ({
      code: input.code,
      suggestions: output(reviewCodeStep),
    }),
    advance: () => ({ default: "continue" }),
    timeout: 60,
  })
  .step(verifyStep, {
    input: ({ input, signal }) => ({
      original: input.code,
      refactoredScore: signal(reviewCodeStep, "clarity_score"),
    }),
    advance: () => ({ default: "continue" }),
  })
  .build();
```
