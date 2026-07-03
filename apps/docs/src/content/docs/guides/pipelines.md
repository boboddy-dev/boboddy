---
title: Building Pipelines
description: Wire steps into orchestrated sequences with typed bindings and advancement policies
---

A **pipeline** is an ordered sequence of steps where each step's input can be bound to work item fields, pipeline-level additional inputs, prior step outputs, or signals extracted from prior results.

## Basic pipeline

The recommended way to define a pipeline is the fluent `pipeline()` builder. Each `.step()` mapper receives a typed `input` accessor that always includes `workItemTitle` and `workItemDescription`.

```typescript
import { pipeline } from "@boboddy/sdk/definitions/pipelines";

export default pipeline({
  key: "code-quality-pipeline",
  name: "Code Quality Pipeline",
  status: "active",
})
  .step(reviewCodeStep, ({ input }) => ({
    title: input.workItemTitle,
    code: input.workItemDescription,
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
| `default-pipeline-assignment.ts` | Project-level routing policy (written if one is configured; removed if not) |
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

| Field                     | Type                  | Required | Description                                                      |
| ------------------------- | --------------------- | -------- | ---------------------------------------------------------------- |
| `key`                     | `string`              | Yes      | Unique identifier for this pipeline                              |
| `name`                    | `string`              | Yes      | Human-readable display name                                      |
| `version`                 | `number`              | No       | Version number (defaults to 1)                                   |
| `description`             | `string`              | No       | Brief description                                                |
| `status`                  | `"draft" \| "active"` | No       | Draft pipelines are not executed                                 |
| `additionalPipelineInput` | `object`              | No       | Custom input fields beyond the built-in work item fields         |

Call `.step(...)`, then `.advance(...)` (required before the next step or `.build()`), and finally `.build()` to produce the wire-format pipeline spec. Timeouts are set via the optional `configFn` third argument to `.step()`.

## Input binding

Inside a `.step()` mapper, four context helpers cover every binding source:

### `input.<path>` — built-in and additional pipeline input

The `input` accessor always exposes `workItemTitle` (string) and `workItemDescription` (string | null), plus any custom fields defined in `additionalPipelineInput.schema`. Drill into the shape; each property access returns a typed binding.

```typescript
.step(reviewCodeStep, ({ input }) => ({
  title: input.workItemTitle,
  body: input.workItemDescription,
  // custom field from additionalPipelineInput:
  code: input.code,
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

### `literal(value)` — a hardcoded constant

```typescript
.step(myStep, ({ literal }) => ({
  model: literal("gpt-4o"),
}))
```

## Additional pipeline input

When a step needs data beyond the built-in work item fields, define it with `additionalPipelineInput`. Both `schema` and `bindings` are required when the object is provided.

```typescript
import { z } from "zod";

export default pipeline({
  key: "ticket-analyzer",
  name: "Ticket Analyzer",
  additionalPipelineInput: {
    schema: z.object({
      storyPoints: z.number().nullable(),
      team: z.string(),
    }),
    bindings: ({ workItem, literal }) => ({
      storyPoints: workItem.field("Story Points"),
      team: literal("platform"),
    }),
  },
})
  .step(analyzeStep, ({ input }) => ({
    title: input.workItemTitle,
    storyPoints: input.storyPoints,
    team: input.team,
  }))
  .advance(() => ({ default: "continue" }))
  .build();
```

The `bindings` callback receives `{ workItem, literal }`:

- **`workItem.title`** / **`workItem.description`** — the work item's title or description
- **`workItem.field(name)`** — a named custom field on the work item (e.g. `workItem.field("Story Points")`)
- **`literal(value)`** — a hardcoded constant

Pipeline-level bindings are defaults applied to every step automatically. Explicit bindings in a `.step()` mapper override them for that step.

`additionalStepInput` on `pipeline(...)` compiles into default bindings applied to every step in the pipeline. Explicit `.step()` bindings override these defaults.

## Plugins in pipeline steps

Opencode plugins are configured on the `defineStep()` itself, not on the pipeline's `.step()` binding mapper. When that step runs inside a pipeline, Boboddy merges the step's `plugins` array into the generated Opencode config for that execution.

Use plain package names for default plugin loading:

```typescript
import { defineStep } from "@boboddy/sdk/definitions/steps";

export const reviewCodeStep = defineStep({
  key: "review-code",
  name: "Review Code",
  agentPrompt: "Review the submitted code.",
  plugins: ["opencode-wakatime", "opencode-helicone-session"],
});
```

If a plugin needs configuration, use the tuple form `[packageName, options]`:

```typescript
plugins: [
  "opencode-wakatime",
  ["@my-org/plugin", { project: "platform" }],
]
```

Plugin entries are deduplicated by package name when Boboddy combines your baseline Opencode config with the step-specific plugins.

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

## Default pipeline assignment

The default pipeline assignment controls which pipeline is automatically started when a new work item arrives in a project. It lives in a reserved file — `.boboddy/pipeline-builder/default-pipeline-assignment.ts` — that is managed separately from regular pipeline definitions.

### File location and authoring

`boboddy pipelines init` scaffolds an example file. `boboddy pipelines pull` writes or removes the file based on the server configuration. `boboddy pipelines push` syncs it back to the server when it is present.

```typescript
import { defaultPipelineAssignment } from "@boboddy/sdk/definitions/pipelines";
import bugTriage from "./bug-triage";
import regressionReview from "./regression-review";

export default defaultPipelineAssignment(({ workItem, any, assign, skip }) => ({
  default: assign(bugTriage),
  rules: [
    any(
      workItem.field("status").eq("resolved"),
      workItem.field("status").eq("manual support"),
    ).then(skip()),
    workItem.field("issueType").eq("bug").then(assign(bugTriage)),
    workItem.field("labels").contains("regression").then(assign(regressionReview)),
  ],
}));
```

The callback receives a context object; everything needed is destructured from it. Only `defaultPipelineAssignment` needs to be imported from the SDK.

### `default`

The outcome when no rule matches. Use `assign(pipeline)` to start a specific pipeline, or `skip()` to do nothing.

```typescript
default: assign(bugTriage)   // always start bugTriage when no rule matches
default: skip()              // do nothing when no rule matches
```

### `rules`

An ordered list of rules evaluated against each incoming work item. The first matching rule wins; unmatched items fall through to `default`.

Each rule is a condition chained with `.then(outcome)`:

```typescript
workItem.field("issueType").eq("bug").then(assign(bugTriage))
workItem.field("labels").contains("regression").then(assign(regressionReview))
workItem.field("status").eq("resolved").then(skip())
```

### Context helpers

| Helper | Description |
|--------|-------------|
| `workItem.field(name)` | Access a work item field by name. Returns a comparator ref. |
| `context.isNew` | `true` when the work item is being created for the first time. Returns a comparator ref. |
| `assign(pipeline)` | Outcome: start the given pipeline. Accepts a `PipelineDefinitionSpec` from `pipeline().build()`. |
| `skip()` | Outcome: do not assign any pipeline. |
| `all(...refs)` | All nested conditions must match. |
| `any(...refs)` | Any nested condition must match. |

### Comparators

The same comparators available in advancement policies work here:

`.eq(v)` · `.ne(v)` · `.gt(n)` · `.gte(n)` · `.lt(n)` · `.lte(n)` · `.in(values)` · `.notIn(values)` · `.contains(v)` · `.doesNotContain(v)`

### Grouping

```typescript
rules: [
  all(
    workItem.field("issueType").eq("bug"),
    workItem.field("priority").eq("high"),
  ).then(assign(bugTriage)),
  any(
    workItem.field("status").eq("resolved"),
    workItem.field("status").eq("closed"),
  ).then(skip()),
]
```

### Push and pull behaviour

- **push** — if `default-pipeline-assignment.ts` is present, its policy is synced to the server after pipelines are pushed. If the file is absent, the server configuration is left unchanged.
- **pull** — if the project has an assignment configured, `default-pipeline-assignment.ts` is written. If no assignment is configured, any existing file is removed.
- Pull fails with a clear error if the server contains rules that were not authored with the SDK fluent API and therefore cannot be reconstructed.

---

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
