---
title: Building Pipelines
description: Wire steps into orchestrated sequences with typed bindings and additional pipeline input
---

A **pipeline** is an ordered sequence of steps where each step's input can be bound to work item fields, pipeline-level additional inputs, prior step outputs, or signals extracted from prior results.

## Basic pipeline

The recommended way to define a pipeline is the fluent `pipeline()` builder. Each `.step()`'s `input` mapper receives a typed `input` accessor that always includes `workItemTitle` and `workItemDescription`.

```typescript
import { pipeline } from "@boboddy/sdk/definitions/pipelines";

export default pipeline({
  key: "code-quality-pipeline",
  name: "Code Quality Pipeline",
  status: "active",
})
  .step(reviewCodeStep, {
    input: ({ input }) => ({
      title: input.workItemTitle,
      code: input.workItemDescription,
    }),
    advance: () => ({ default: "continue" }),
  })
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

For a brand-new project with no definitions on the server yet, use [`boboddy pipelines design`](/boboddy/reference/cli/#boboddy-pipelines-design-projectid) — it scaffolds the directory, interviews you, and writes the definitions. `boboddy pipelines init` scaffolds a starter template for hand-authoring instead.

After pulling, install dependencies inside the directory:

```bash
cd .boboddy/pipeline-builder && npm install
```

Your pipeline and step definitions in this directory are source code — commit them. The scaffolded `.gitignore` only excludes `node_modules/`, lockfiles, and the generated `push.ts`. Run `npm run typecheck` in the directory to validate definitions before pushing.

When you're ready to publish changes back:

```bash
boboddy pipelines push
```

This pushes steps first, then pipelines, in a single command.

## `pipeline()` options

| Field                     | Type                  | Required | Description                                                      |
| ------------------------- | --------------------- | -------- | ------------------------------------------------------------------ |
| `key`                     | `string`              | Yes      | Unique identifier for this pipeline                              |
| `name`                    | `string`              | Yes      | Human-readable display name                                      |
| `version`                 | `number`              | No       | Version number (defaults to 1)                                   |
| `description`             | `string`              | No       | Brief description                                                |
| `status`                  | `"draft" \| "active"` | No       | Draft pipelines are not executed                                 |
| `additionalPipelineInput` | `object`              | No       | Custom input fields beyond the built-in work item fields         |

Call `.step(step, options)` for each step in sequence, then finish with `.build()` to produce the wire-format pipeline spec. `options.advance` is required on every step — it decides how the pipeline continues past that step. `options.timeout` (optional, seconds) caps how long a worker can spend on the step. See [Pipeline Advancement](/boboddy/guides/pipeline-advancement/) for how `advance` policies work.

## Input binding

Inside a `.step()`'s `input` option, five context helpers cover every binding source:

### `input.<path>` — built-in and additional pipeline input

The `input` accessor always exposes `workItemTitle` (string) and `workItemDescription` (string | null), plus any custom fields defined in `additionalPipelineInput.schema`. Drill into the shape; each property access returns a typed binding.

```typescript
.step(reviewCodeStep, {
  input: ({ input }) => ({
    title: input.workItemTitle,
    body: input.workItemDescription,
    // custom field from additionalPipelineInput:
    code: input.code,
  }),
  advance: () => ({ default: "continue" }),
})
```

Nested fields work as you'd expect — `input.ticket.title` binds to the dotted path `"ticket.title"`. **Do not** spread or coerce the accessor (`${input.code}`, `{ ...input.metadata }`): it will throw at build time. Drill into specific fields instead.

### `signal(step, signalKey)` — bind to a prior step's signal

```typescript
.step(refactorStep, {
  input: ({ input, signal }) => ({
    code: input.code,
    previousScore: signal(reviewCodeStep, "clarity_score"),
  }),
  advance: () => ({ default: "continue" }),
})
```

`signalKey` is constrained to the prior step's declared signal keys, so typos are compile errors.

### `output(step)` — bind to a prior step's whole output

```typescript
.step(refactorStep, {
  input: ({ input, output }) => ({
    code: input.code,
    reviewResult: output(reviewCodeStep),
  }),
  advance: () => ({ default: "continue" }),
})
```

### `literal(value)` — a hardcoded constant

```typescript
.step(myStep, {
  input: ({ literal }) => ({
    model: literal("gpt-4o"),
  }),
  advance: () => ({ default: "continue" }),
})
```

### `signalsList(fanOutStep)` — bind to a fan-out's whole cohort

Available from any step after a [fan-out](#fan-out-parallel-branches)'s `.advanceAll()` gate, even non-adjacent ones. Resolves to every terminal branch's signals, aggregated server-side.

```typescript
.step(reportStep, {
  input: ({ signalsList }) => ({
    reviews: signalsList(reviewStep),
  }),
  advance: () => ({ default: "continue" }),
})
```

`fanOutStep` is constrained to a step already passed as the first argument to an earlier `.fanOutStep(...)` call in this pipeline.

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
  .step(analyzeStep, {
    input: ({ input }) => ({
      title: input.workItemTitle,
      storyPoints: input.storyPoints,
      team: input.team,
    }),
    advance: () => ({ default: "continue" }),
  })
  .build();
```

The `bindings` callback receives `{ workItem, literal }`:

- **`workItem.title`** / **`workItem.description`** — the work item's title or description
- **`workItem.field(name)`** — a named custom field on the work item (e.g. `workItem.field("Story Points")`)
- **`literal(value)`** — a hardcoded constant

Pipeline-level bindings are defaults applied to every step automatically. Explicit bindings in a `.step()`'s `input` option override them for that step.

`additionalStepInput` on `pipeline(...)` compiles into default bindings applied to every step in the pipeline. Explicit `.step()` `input` bindings override these defaults.

## Plugins in pipeline steps

Opencode plugins are configured on the `defineStep()` itself, not on the pipeline's `.step()` input option. When that step runs inside a pipeline, Boboddy merges the step's `plugins` array into the generated Opencode config for that execution.

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

## Timeouts

Set `timeout` in a step's options to cap how long a worker can spend on that step, in seconds:

```typescript
.step(heavyAnalysisStep, {
  input: ({ input }) => ({ payload: input.payload }),
  advance: () => ({ default: "continue" }),
  timeout: 120,
})
```

## Fan-out: parallel branches

`.fanOutStep(step, config)` runs one step as a variable number of parallel branches — think "review each of the N reviewers" or "process each of the N files" — instead of the single fixed execution `.step(...)` gives you. It replaces `.step(...)` at that point in the chain (do not call both for the same step) and always compiles to a `fanOut` node paired with a `cohortGate` node immediately after it.

```typescript
import { pipeline } from "@boboddy/sdk/definitions/pipelines";

export default pipeline({ key: "code-review", name: "Code Review" })
  .step(triageStep, { advance: () => ({ default: "continue" }) })
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
  .step(reportStep, {
    input: ({ signalsList }) => ({ reviews: signalsList(reviewStep) }),
    advance: () => ({ default: "continue" }),
  })
  .build();
```

`over`'s resolved signal shape decides the branch mode. A number-typed signal (like `reviewer_count` above) resolves a fixed branch count, with no `item` on the `input` mapper's ctx. An array-typed signal resolves branch count from the array's length and adds a typed `item` — the array's element type — to every branch's `input` mapper:

```typescript
.fanOutStep(assigneeReviewStep, {
  over: "assigneeIds", // a string[] signal on the preceding step
  input: ({ item, input }) => ({
    assigneeId: item,
    ticketTitle: input.workItemTitle,
  }),
  advance: () => ({ default: "continue" }),
  advanceAll: () => ({ default: "continue" }),
})
```

`.fanOutStep(step, config)` requires `over`, `advance`, and `advanceAll` in its single `config` object (`input` and `timeout` are optional). Only after `advanceAll` resolves can the pipeline continue with another `.step(...)` — that step is wired as the `cohortGate`'s successor.

### `FanOutStepConfig`

| Field        | Type                 | Required | Description                                                                                             |
| ------------ | -------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `over`       | string               | Yes      | Signal on the most recently declared step whose value determines branch count (and, if array-typed, each branch's `item`) at runtime |
| `advance`    | `(ctx) => result`    | Yes      | Every branch's own continue/block decision, evaluated against that branch's own signals                |
| `advanceAll` | `(ctx) => result`    | Yes      | The whole cohort's continue/block decision, once every branch has settled                               |
| `input`      | `(ctx) => bindings`  | No       | Input bindings for the fan-out step, same accessors as `.step(...)`'s mapper, plus `item` when `over` resolves to an array-typed signal |
| `timeout`    | `number \| null`     | No       | Per-branch timeout in seconds                                                                            |

`over` is typed against the signal keys declared on the most recently declared step — not necessarily the fan-out's graph predecessor if a second `.fanOutStep()` immediately follows an `advanceAll` gate with no intervening `.step()`.

See [Pipeline Advancement](/boboddy/guides/pipeline-advancement/#fan-out-cohort-advancement-advance--advanceall) for the full `advance`/`advanceAll` callback contexts.

## See also

- [Pipeline Advancement](/boboddy/guides/pipeline-advancement/) — advancement policies and computed signals.
- [Default Pipeline Assignment](/boboddy/guides/pipeline-assignment/) — routing incoming work items to a pipeline automatically.
