---
name: boboddy-pipeline
description: Create boboddy pipeline definitions from a natural-language description of steps, with a user-review gate before pushing
---

## What I do

I translate a plain-language description of an agentic pipeline into a working TypeScript pipeline definition file using the boboddy SDK. I then pause for the user to review the definition before any push happens.

## When to use me

Invoke me when a user says something like "create a pipeline that first investigates an issue, then triages it, then sends a report" — any request to build or modify a boboddy pipeline from a description of steps.

---

## Workflow

1. If `.boboddy/pipeline-builder/` does not exist, run `boboddy pipelines init` to scaffold it.
2. Create or edit a `.ts` file inside `.boboddy/pipeline-builder/`. Each file must export a default `pipeline(...).step(...).advance(...).build()` chain.
3. Present the pipeline definition to the user for review. Summarize the steps, input bindings, and advancement rules so the user can verify intent without re-reading the file.
4. Wait for explicit approval. Do not run `boboddy pipelines push` until the user confirms. If they request changes, iterate on the file and re-surface for review.
5. Once approved, ask whether the user wants to push themselves or have me push. Only run `boboddy pipelines push` (or `boboddy pipelines push <projectId>`) if they choose the latter. The CLI auto-pushes any step definitions it finds in the same directory first.

---

## Imports

```typescript
import { z } from "zod";
import { defineStep, Features } from "@boboddy/sdk/definitions/steps";
import { pipeline } from "@boboddy/sdk/definitions/pipelines";
```

---

## Defining steps

Each step represents one unit of agent work. Define every step before the pipeline builder.

```typescript
export const myStep = defineStep({
  key: "my-step",           // lowercase kebab-case, unique per project
  name: "My Step",          // display name
  description: "...",       // optional
  version: 1,               // increment when schema changes
  status: "active",         // "draft" | "active" (default: "active")

  // Required string prompt for the executing agent:
  agentPrompt: "You are an analyst. Evaluate the input and return a score.",

  // Optional: Zod schema for additional inputs beyond the built-in work item fields.
  // Fields are bound in the pipeline mapper.
  additionalInput: z.object({
    content: z.string(),
  }),

  // Zod schema for what the step produces
  result: z.object({
    summary: z.string(),
    confidence: z.number(),
    approved: z.boolean(),
  }),

  // Signals: named values extracted from the result, usable in advancement rules
  // and as bindings for downstream steps.
  // key defaults to sourcePath if omitted.
  // type is inferred from the result schema if omitted.
  signals: [
    { sourcePath: "confidence" },             // key = "confidence", type = "number"
    { key: "ok", sourcePath: "approved" },    // explicit key
  ],

  // Optional: MCP servers available as tools during this step
  mcpServers: {
    postgres: {
      type: "local",
      command: ["uvx", "postgres-mcp", "--access-mode=unrestricted"],
      environment: { DATABASE_URI: "{env:DATABASE_URI}" },
    },
  },

  // Optional: add built-in feature plugins
  features: [Features.feedbackRequests()],
});
```

### Signal types
`"string"` | `"number"` | `"boolean"` | `"object"` | `"array"`

### `Features.feedbackRequests()`
Adds a `feedbackRequests?: FeedbackRequestItem[]` field to the result and injects a prompt instructing the agent to surface questions for human review. Use when a step may need to escalate unclear cases.

---

## Defining a pipeline

Pipelines use a fluent builder. The chain is: `pipeline(meta)` → `.step(step, mapper, configFn?)` → `.advance(ctx => ...)` → repeat or `.build()`.

`.advance()` is required after every `.step()` before you can add another step or call `.build()`.

```typescript
export default pipeline({
  key: "my-pipeline",       // lowercase kebab-case, unique per project
  name: "My Pipeline",
  description: null,        // optional
  version: 1,
  status: "active",         // "draft" | "active" (default: "active")
  // Optional: define custom pipeline input fields beyond the built-in work item fields.
  // Both schema and bindings are required when this object is provided.
  additionalPipelineInput: {
    schema: z.object({ body: z.string(), userId: z.string() }),
    bindings: ({ workItem, literal }) => ({
      body: workItem.description,      // bind from the work item
      userId: literal("system"),       // or a hardcoded constant
    }),
  },
  // Optional: define default step bindings applied to every step in this pipeline.
  additionalStepInput: {
    schema: z.object({ priority: z.string().nullable() }),
    bindings: ({ workItemField }) => ({
      priority: workItemField("Priority"),
    }),
  },
})
  .step(stepOne, ({ input }) => ({
    content: input.body,
  }))
  .advance(({ signal }) => ({
    default: "block",
    rules: [signal("confidence").gte(0.8).then("continue")],
  }))
  .step(stepTwo, ({ signal, output }) => ({
    priorSummary: signal(stepOne, "summary"),
    fullResult: output(stepOne),
  }))
  .advance(() => ({ default: "continue" }))
  .build();
```

---

## Step input bindings

Each `.step(step, mapper)` mapper receives a context object `{ input, signal, output, literal }` and must return a record mapping the step's input fields to bindings.

### `input.<path>` — work item fields and additional pipeline input

`input` is a typed proxy that always exposes two built-in fields:
- `input.workItemTitle` — the title of the work item triggering this run
- `input.workItemDescription` — the description of the work item (may be null)

It also exposes any custom fields defined in `additionalPipelineInput.schema`. Drill into fields — each access returns a binding for that path.

```typescript
.step(investigate, ({ input }) => ({
  title: input.workItemTitle,
  body: input.workItemDescription,
  // custom field from additionalPipelineInput.schema:
  userId: input.userId,
  // nested paths also work:
  ticketTitle: input.meta.title,
}))
```

Do **not** spread or coerce the accessor (`${input.code}`, `{ ...input.metadata }`) — it will throw at build time.

### `signal(priorStep, signalKey)` — a named signal from an earlier step

```typescript
.step(triage, ({ signal }) => ({
  confidence: signal(investigate, "confidence"),
}))
```

`signalKey` is TypeScript-validated against the prior step's declared signals.

### `output(priorStep)` — the entire result object of a prior step

```typescript
.step(report, ({ output }) => ({
  data: output(investigate),
}))
```

Prefer `signal` for stability; use `output` when you need the full object.

### `literal(value)` — a hardcoded constant

```typescript
.step(myStep, ({ literal }) => ({
  model: literal("gpt-4o"),
}))
```

---

## Advancement policies

`.advance(callback)` attaches a policy to the most recently added step. The callback receives a context with typed helpers and must return `{ default, rules? }`.

```typescript
.advance(({ signal }) => ({
  default: "block",
  rules: [
    signal("confidence").gte(0.8).then("continue"),
  ],
}))
```

### Outcomes

| Outcome | Meaning |
|---|---|
| `"continue"` | Advance to the next step automatically |
| `"block"` | Pause; wait for human intervention |
| `"needs_review"` | Flag for review before proceeding |
| `"complete"` | End the pipeline here |

To route to another pipeline:
```typescript
signal("flagged").eq(true).then(route("triage-pipeline", { reason: "flagged" }))
```

### Signal references

`signal(key)` returns a `SignalRef`. Chain a comparator, then `.then(outcome)` to produce a rule:

```typescript
signal("score").gte(0.8).then("continue")
```

The `stepSignals` property map is an alternative shorthand — both are equivalent:
```typescript
// These are identical:
signal("score").gte(0.8).then("continue")
stepSignals.score.gte(0.8).then("continue")
```

### Comparators on `SignalRef`

| Method | Operator |
|---|---|
| `.eq(value)` | `equal` |
| `.ne(value)` | `notEqual` |
| `.gt(n)` | `greaterThan` |
| `.gte(n)` | `greaterThanInclusive` |
| `.lt(n)` | `lessThan` |
| `.lte(n)` | `lessThanInclusive` |
| `.in(values)` | `in` |
| `.notIn(values)` | `notIn` |
| `.contains(value)` | `contains` |
| `.doesNotContain(v)` | `doesNotContain` |

### Grouping with `all` and `any`

```typescript
.advance(({ signal, all, any }) => ({
  default: "block",
  rules: [
    all(
      signal("score").gte(0.8),
      any(
        signal("reviewerApproved").eq(true),
        signal("autoApproved").eq(true),
      ),
    ).then("continue"),
  ],
}))
```

Groups are nestable arbitrarily. Call `.then(outcome)` to close the rule.

### Computed signals

Aggregate multiple signals into a derived value inline — no separate declaration on the step required. Factories accept 2+ `signal(key)` or `stepSignals.key` references:

```typescript
.advance(({ avg, stepSignals }) => ({
  default: "block",
  rules: [
    avg(stepSignals.score1, stepSignals.score2).gte(0.7).then("continue"),
  ],
}))
```

The same call across multiple rules is deduplicated into a single computed-signal definition at build time.

| Factory | Description | Signal types |
|---|---|---|
| `avg(...)` | Arithmetic mean | `number` |
| `weightedAvg(...)` | Weighted mean | `number` |
| `sum(...)` | Sum | `number` |
| `min(...)` | Minimum | `number` |
| `max(...)` | Maximum | `number` |
| `count(...)` | Count of truthy/present values | any |
| `booleanAny(...)` | `true` if any input is truthy | `boolean` |
| `booleanAll(...)` | `true` only if all inputs are truthy | `boolean` |

---

## Timeouts

Pass a third `configFn` argument to `.step()` to cap how long a worker can spend on that step:

```typescript
.step(
  heavyAnalysisStep,
  ({ input }) => ({ payload: input.payload }),
  (cfg) => { cfg.timeout = 900; },   // seconds
)
```

---

## Complete example

```typescript
import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";
import { pipeline } from "@boboddy/sdk/definitions/pipelines";

export const investigate = defineStep({
  key: "investigate",
  name: "Investigate",
  version: 1,
  agentPrompt: "Analyze the provided issue title and body, then return a concise summary and confidence score.",
  additionalInput: z.object({ title: z.string(), body: z.string() }),
  result: z.object({ summary: z.string(), confidence: z.number() }),
  signals: [
    { sourcePath: "confidence" },
    { sourcePath: "summary" },
  ],
});

export const triage = defineStep({
  key: "triage",
  name: "Triage",
  version: 1,
  agentPrompt: "Given the investigation summary, assign a priority: low, medium, or high.",
  additionalInput: z.object({ summary: z.string() }),
  result: z.object({ priority: z.string() }),
  signals: [{ sourcePath: "priority" }],
});

export default pipeline({
  key: "issue-pipeline",
  name: "Issue Pipeline",
  version: 1,
})
  .step(investigate, ({ input }) => ({
    title: input.workItemTitle,
    body: input.workItemDescription,
  }))
  .advance(({ signal }) => ({
    default: "block",
    rules: [signal("confidence").gte(0.8).then("continue")],
  }))
  .step(triage, ({ signal }) => ({
    summary: signal(investigate, "summary"),
  }))
  .advance(() => ({ default: "continue" }))
  .build();
```

---

## Deploying

Only push after the user has reviewed and approved the pipeline definition. Once approved, ask whether the user wants to push themselves or wants me to run the push.

```bash
# First time setup (creates .boboddy/pipeline-builder/ with example files)
boboddy pipelines init

# Fetch existing definitions from the server as editable TypeScript
boboddy pipelines pull

# Push all pipeline definitions (also pushes step definitions automatically)
boboddy pipelines push

# Push to a specific project
boboddy pipelines push <projectId>
```

Steps referenced in a pipeline must exist on the server. The `push` command handles this automatically by pushing all step definitions found in `.boboddy/pipeline-builder/` before pushing pipelines.

Incrementing `version` in `defineStep` or `pipeline()` creates a new entity on the server rather than updating the existing one.
