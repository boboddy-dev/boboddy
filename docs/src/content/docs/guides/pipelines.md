---
title: Building Pipelines
description: Wire steps into orchestrated sequences with typed bindings and advancement policies
---

A **pipeline** is an ordered sequence of steps where each step's input can be bound to pipeline-level inputs, prior step outputs, or signals extracted from prior results.

## Basic pipeline

The recommended way to define a pipeline is the fluent `pipeline()` builder. The schema is bound once at the top; each `.step()` mapper receives a typed `input` accessor.

```typescript
import { pipeline } from "@boboddy/sdk/definitions/pipelines";
import { z } from "zod";
import { reviewCodeStep } from "./steps";

const inputSchema = z.object({
  code: z.string(),
});

export default pipeline({
  key: "code-quality-pipeline",
  name: "Code Quality Pipeline",
  status: "active",
  input: inputSchema,
})
  .step(reviewCodeStep, ({ input }) => ({
    code: input.code,
  }))
  .advance(() => ({ default: "continue" }))
  .build();
```

## Scaffold pipeline definitions

Run this command to fetch your existing step and pipeline definitions from the server and write them as editable TypeScript files:

```bash
boboddy pipelines pull
```

This creates (or overwrites) the following files inside `.boboddy/pipeline-builder/`:

| File | Description |
|------|-------------|
| `steps.ts` | One `defineStep()` export per step (latest version of each key) |
| `<pipeline-key>.ts` | One pipeline export per pipeline |
| `package.json` | SDK and zod dependencies (written once, never overwritten) |
| `tsconfig.json` | TypeScript config for the package (written once, never overwritten) |

For a brand-new project with no definitions on the server yet, use `boboddy pipelines init` instead to get a starter template.

After pulling, install dependencies inside the directory:

```bash
cd .boboddy/pipeline-builder && npm install
```

When you're ready to publish changes back:

```bash
boboddy pipelines push
```

This pushes steps first, then pipelines, in a single command.

## `pipeline()` options

| Field         | Type                  | Required | Description                                |
| ------------- | --------------------- | -------- | ------------------------------------------ |
| `key`         | `string`              | Yes      | Unique identifier for this pipeline        |
| `name`        | `string`              | Yes      | Human-readable display name                |
| `input`       | `ZodType`             | Yes      | Schema bound to the `input` accessor       |
| `version`     | `number`              | No       | Version number (defaults to 1)             |
| `description` | `string`              | No       | Brief description                          |
| `status`      | `"draft" \| "active"` | No       | Draft pipelines are not executed           |

Call `.step(...)`, then `.advance(...)` (required before the next step or `.build()`), and finally `.build()` to produce the wire-format pipeline spec. Timeouts are set via the optional `configFn` third argument to `.step()`.

## Input binding

Inside a `.step()` mapper, three context helpers cover every binding source:

### `input.<path>` — bind to the pipeline input

The `input` accessor is a proxy bound to the schema passed to `pipeline({ input })`. Drill into the schema's shape; each property access returns a typed binding to that pipeline-input path.

```typescript
.step(reviewCodeStep, ({ input }) => ({
  code: input.code,
  language: input.language,
}))
```

Nested fields work as you'd expect — `input.ticket.title` binds to the dotted path `"ticket.title"`. **Do not** spread or coerce the accessor (`${input.code}`, `{ ...input.metadata }`): it will throw at build time. Drill into specific fields instead.

### `signal(step, signalKey)` — bind to a prior step's signal

```typescript
.step(refactorStep, ({ input, signal }) => ({
  code: input.code,
  previousScore: signal(reviewCodeStep, "clarity_score"),
}))
```

`signalKey` is constrained to the prior step's declared signal keys, so typos are compile errors.

### `output(step)` — bind to a prior step's whole output

```typescript
.step(refactorStep, ({ input, output }) => ({
  code: input.code,
  reviewResult: output(reviewCodeStep),
}))
```

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

const inputSchema = z.object({ code: z.string() });

export default pipeline({
  key: "full-review",
  name: "Full Code Review Pipeline",
  status: "active",
  input: inputSchema,
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

## Timeouts

Pass a third `configFn` argument to `.step()` to cap how long a worker can spend on that step. Set `cfg.timeout` in seconds:

```typescript
.step(
  heavyAnalysisStep,
  ({ input }) => ({ payload: input.payload }),
  (cfg) => { cfg.timeout = 120; },
)
```

---

## Legacy `definePipeline` form

The original object-based API is still supported and produces identical wire output. New pipelines should prefer the builder.

```typescript
import {
  definePipeline,
  fromPipelineInput,
  Rule,
} from "@boboddy/sdk/definitions/pipelines";
import { z } from "zod";
import { reviewCodeStep } from "./steps";

const inputSchema = z.object({ code: z.string() });

export default definePipeline({
  key: "code-quality-pipeline",
  name: "Code Quality Pipeline",
  status: "active",
  steps: [
    {
      step: reviewCodeStep,
      input: {
        code: fromPipelineInput(inputSchema, "code"),
      },
      advancement: {
        defaultOutcome: "block",
        rules: [Rule.when("clarity_score", "greaterThan", 7, "continue")],
      },
    },
  ],
});
```

`fromPipelineInput`, `fromSignal`, `stepOutput`, `Rule`, and `Computed` remain exported from `@boboddy/sdk/definitions/pipelines`.
