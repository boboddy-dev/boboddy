---
title: Building Pipelines
description: Wire steps into orchestrated sequences with typed bindings and additional pipeline input
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

Call `.step(...)`, then `.advance(...)` (required before the next step or `.build()`), and finally `.build()` to produce the wire-format pipeline spec. Timeouts are set via the optional `configFn` third argument to `.step()`. See [Pipeline Advancement](/boboddy/guides/pipeline-advancement/) for how `.advance()` policies work.

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

## Timeouts

Pass a third `configFn` argument to `.step()` to cap how long a worker can spend on that step. Set `cfg.timeout` in seconds:

```typescript
.step(
  heavyAnalysisStep,
  ({ input }) => ({ payload: input.payload }),
  (cfg) => { cfg.timeout = 120; },
)
```

## See also

- [Pipeline Advancement](/boboddy/guides/pipeline-advancement/) — advancement policies and computed signals.
- [Default Pipeline Assignment](/boboddy/guides/pipeline-assignment/) — routing incoming work items to a pipeline automatically.
