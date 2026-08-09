---
title: Pipeline Advancement
description: Decide whether a pipeline continues, blocks, or routes elsewhere using advancement policies and computed signals
---

`.advance(callback)` attaches an advancement policy to the most recently added step in a `pipeline()` definition — it's required before adding another step or calling `.build()`. See [Building Pipelines](/boboddy/guides/pipelines/) for the `pipeline()` builder itself.

## Advancement policies

`.advance(callback)` attaches a policy to the most recently added step. The callback receives a context with `signal`, `all`, `any`, `route`, and every computed-signal factory. The signal keys are typed against the just-added step.

```typescript
.step(reviewCodeStep, ({ input }) => ({ code: input.code }))
.advance(({ signal }) => ({
  default: "block",
  rules: [signal("clarity_score").gt(7).then("continue")],
}))
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
.advance(({ signal, all, any }) => ({
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
}))
```

Groups are nestable arbitrarily. Each `.then(outcome)` closes the rule.

### Routing to another pipeline

```typescript
.advance(({ signal, route }) => ({
  default: "complete",
  rules: [
    signal("flagged").eq(true).then(route("triage-pipeline", { reason: "flagged" })),
  ],
}))
```

## Computed signals

Computed signals aggregate multiple raw signals into a derived value inline. The factories live on the same `.advance()` context — no separate declaration on the step required.

```typescript
.advance(({ avg, signal, stepSignals }) => ({
  default: "block",
  rules: [
    avg(stepSignals.quality_score, stepSignals.security_score).gte(7).then("continue"),
    signal("flagged").eq(true).then("block"),
  ],
}))
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
  .step(reviewCodeStep, ({ input }) => ({
    code: input.code,
  }))
  .advance(({ signal }) => ({
    default: "block",
    rules: [signal("clarity_score").gt(6).then("continue")],
  }))
  .step(
    refactorStep,
    ({ input, output }) => ({
      code: input.code,
      suggestions: output(reviewCodeStep),
    }),
    (cfg) => { cfg.timeout = 60; },
  )
  .advance(() => ({ default: "continue" }))
  .step(verifyStep, ({ input, signal }) => ({
    original: input.code,
    refactoredScore: signal(reviewCodeStep, "clarity_score"),
  }))
  .advance(() => ({ default: "continue" }))
  .build();
```
