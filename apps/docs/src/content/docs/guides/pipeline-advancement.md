---
title: Pipeline Advancement
description: Block, branch, loop, and route with the Rule DSL and fan-out cohort advancement
---

A pipeline has two distinct advancement mechanisms:

- The **`Rule` DSL** — used by a `step` state's `blockWhen`, a `choice` state's `choices[].when`, and a `loop` state's `until`. Conditions are built with `Rule.when(...)` / `Rule.signal(...)` / `Rule.all(...)` / `Rule.any(...)`.
- **Cohort advancement** — used by a `fanOut` state's `advanceEach`/`advanceAll` and a `parallel` state's `advanceAll`. These use a fluent, comparator-chain context (`signal(key).eq(value).then(outcome)`), evaluated per-branch and per-cohort.

See [Building Pipelines](/boboddy/guides/pipelines/) for the state shapes themselves.

## The `Rule` DSL

```typescript
import { Rule } from "@boboddy/sdk/definitions/pipelines";

Rule.when(signalKey, operator, value); // a bare condition
Rule.signal(signalKey, operator, value); // the same leaf, for nesting in all/any
Rule.all([condition, condition]); // every nested condition must match
Rule.any([condition, condition]); // any nested condition must match
```

`Rule.when` and `Rule.signal` are equivalent leaf conditions — use `Rule.when` on its own, and `Rule.signal` when nesting inside `Rule.all`/`Rule.any`:

```typescript
Rule.any([
  Rule.signal("score", "lessThan", 0.3),
  Rule.all([
    Rule.signal("reviewerApproved", "equal", false),
    Rule.signal("autoApproved", "equal", false),
  ]),
])
```

### Operators

| Operator                | Description             |
| ------------------------ | ----------------------- |
| `equal`                  | Equal to                |
| `notEqual`                | Not equal to             |
| `lessThan`                | Less than                |
| `lessThanInclusive`       | Less than or equal to    |
| `greaterThan`             | Greater than             |
| `greaterThanInclusive`    | Greater than or equal to |
| `in`                      | Value is one of a list   |
| `notIn`                   | Value is not in a list   |
| `contains`                | Contains a value          |
| `doesNotContain`          | Does not contain a value |

:::caution
No condition's signal argument is type-checked. A typo in `Rule.when("confidnce", ...)` compiles cleanly and only fails at execution time — re-read every signal key against the step's declared `signals` by eye.
:::

### Computed signals

Aggregate several raw signals into a derived value inline with the `Computed` namespace, passed where a plain signal key would go:

```typescript
Rule.signal(
  Computed.average(["quality_score", "security_score"]),
  "greaterThanInclusive",
  7,
)
```

| Factory                          | Description                                       | Input signal types |
| --------------------------------- | -------------------------------------------------- | ------------------- |
| `Computed.average(keys)`          | Arithmetic mean of the input signals               | `number`            |
| `Computed.weightedAverage(keys)`  | Weighted mean (pass weights via a later configJson)| `number`            |
| `Computed.sum(keys)`              | Sum of the input signals                           | `number`            |
| `Computed.min(keys)`              | Minimum value across the input signals             | `number`            |
| `Computed.max(keys)`              | Maximum value across the input signals             | `number`            |
| `Computed.count(keys)`            | Count of truthy or present signal values           | `any`               |
| `Computed.booleanAny(keys)`       | `true` if any input signal is truthy               | `boolean`           |
| `Computed.booleanAll(keys)`       | `true` only if all input signals are truthy        | `boolean`           |

Each factory requires **at least two** signal keys, passed as an array. Identical calls are deduplicated into a single computed-signal definition at build time.

## Blocking a step: `blockWhen`

A single-condition "pause for human review" gate on a `step` state:

```typescript
{
  kind: "step",
  step: triageStep,
  blockWhen: Rule.when("confidence", "lessThan", 7),
  next: "writeFixPlan",
}
```

When `blockWhen`'s condition matches, the run **blocks** in the dashboard instead of advancing to `next`. Read it as "block when this is true" — the inverse of writing a "continue when" condition. If your business rule is "continue only when reproduced and confidence ≥ 0.8", write `blockWhen` as the negation:

```typescript
blockWhen: Rule.any([
  Rule.signal("reproduced", "equal", false),
  Rule.signal("confidence", "lessThan", 0.8),
]),
```

## Branching: `choice`

A `choice` state holds the whole routing table in one place:

```typescript
routeBySeverity: {
  kind: "choice",
  choices: [
    { when: Rule.when("severity", "equal", "critical"), next: "pageOncall" },
  ],
  default: "fanOutFiles",
}
```

Each `choices[]` entry pairs a `Rule` condition with the state to run when it matches; the first matching entry wins. `default` is the fallback when no `choices[]` entry matches. Both `choices[].next` and `default` must name another state **in the same pipeline** — a `choice` cannot route to a different pipeline and cannot block directly. To route conditionally to one of several pipelines, point each `choice` branch at its own small `step` state that does the routing (see [Routing to another pipeline](#routing-to-another-pipeline)).

## Looping: `until`

A `loop` state's `until` is a `Rule` condition tested after each iteration; matching exits the loop via `next`, while hitting `maxIterations` first exits via `onExhausted`:

```typescript
refineUntilPasses: {
  kind: "loop",
  step: refineStep,
  maxIterations: 5,
  until: Rule.when("passesLint", "equal", true),
  next: "publish",
  onExhausted: "escalateToHuman",
}
```

## Routing to another pipeline

A `step`/`fanOut`/`parallel`/loop-exit's `next` can target a different pipeline instead of a state key:

```typescript
next: { routeToPipeline: "triage-pipeline" }
```

`routeToPipeline` must name a pipeline that already exists on the server or is in the same push batch — push validates it and throws otherwise. A `choice` branch can never target `routeToPipeline` directly (see [Branching](#branching-choice)).

## Fan-out cohort advancement: `advanceEach` / `advanceAll`

A [fan-out](/boboddy/guides/pipelines/#fan-out-parallel-branches) (`kind: "fanOut"`) runs a step as N parallel branches, and needs two advancement decisions instead of one: each branch's own outcome (`advanceEach`), then the whole cohort's outcome once every branch has settled (`advanceAll`). A `parallel` state only has `advanceAll`, evaluated the same way. Both are restricted to a narrower `"continue" | "block"` outcome domain — no routing, since a branch or cohort can't redirect the pipeline to a different one.

```typescript
fanOutReviewers: {
  kind: "fanOut",
  step: reviewStep,
  over: "reviewer_count",
  advanceEach: ({ signal }) => ({
    default: "continue",
    rules: [signal("passed").eq(false).then("block")],
  }),
  advanceAll: ({ branchOutcomes }) => ({
    default: "block",
    rules: [branchOutcomes.every("continue").then("continue")],
  }),
  next: "report",
}
```

### `advanceEach` — one branch's own outcome

Evaluated per-branch against that branch's own signals. The callback context provides `signal(key)`, `stepSignals.<key>`, `all(...)`, and `any(...)` — no computed-signal factories (`Computed.average`, etc.), since core has no mechanism yet to resolve a computed signal against a fan-out branch's policy.

```typescript
advanceEach: ({ signal, all }) => ({
  default: "continue",
  rules: [
    all(signal("confidence").lt(0.5), signal("passed").eq(false)).then("block"),
  ],
}),
```

`signal(key)` / `stepSignals.<key>` return a comparator-bound ref — chain `.eq()`, `.ne()`, `.gt()`, `.gte()`, `.lt()`, `.lte()`, `.in()`, `.notIn()`, `.contains()`, `.doesNotContain()`, then `.then(outcome)` to finalize as a rule (`outcome` is `"continue" | "block"`).

### `advanceAll` — the whole cohort's outcome

Evaluated once per cohort, after every branch has resolved to an outcome. The callback context provides `branchOutcomes`, `stepSignalsList`, `all(...)`, and `any(...)`.

#### `branchOutcomes`

| Method                | Description                                                     |
| --------------------- | ----------------------------------------------------------------- |
| `.total()`            | The cohort's total branch count (fact `branchCount`)             |
| `.count(outcome)`     | A single outcome's count across the cohort (fact `${outcome}Count`) |
| `.every(outcome)`     | `true` iff every branch resolved to this outcome                  |
| `.some(outcome)`      | `true` iff at least one branch resolved to this outcome           |

`outcome` is one of `"continue" | "block" | "error" | "abandoned"` — the 4-value branch outcome classification (`error`/`abandoned` cover branches that failed or never ran, and can't be produced by `advanceEach` itself). `.total()` and `.count()` return a comparator ref — chain a comparator (`.eq`, `.gt`, `.gte`, etc.) and `.then(outcome)` to finalize. `.every()`/`.some()` are already booleans — go straight to `.then(outcome)`.

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

Aggregates a signal across every branch in the cohort. Seed with `.pluck(signalKey)`, optionally reshape with `.filter(operator, value)` / `.sortBy(direction?)` / `.unique()`, then finalize with exactly one reducer:

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

Each reducer returns a comparator ref — chain a comparator and `.then(outcome)` the same as `branchOutcomes`.

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
import { definePipeline, Rule } from "@boboddy/sdk/definitions/pipelines";
import { z } from "zod";
import { reviewCodeStep, refactorStep, verifyStep } from "./steps";

export default definePipeline({
  key: "full-review",
  name: "Full Code Review Pipeline",
  status: "active",
  input: z.object({ code: z.string() }),
  startAt: "review",
  states: {
    review: {
      kind: "step",
      step: reviewCodeStep,
      input: (ctx) => ({ code: ctx.pipelineInput("code") }),
      blockWhen: Rule.when("clarity_score", "lessThanInclusive", 6),
      next: "refactor",
    },
    refactor: {
      kind: "step",
      step: refactorStep,
      input: (ctx) => ({
        code: ctx.pipelineInput("code"),
        suggestions: ctx.output("review"),
      }),
      timeout: 60,
      next: "verify",
    },
    verify: {
      kind: "step",
      step: verifyStep,
      input: (ctx) => ({
        original: ctx.pipelineInput("code"),
        refactoredScore: ctx.signal("review", "clarity_score"),
      }),
      next: "done",
    },
    done: { kind: "succeed" },
  },
});
```
