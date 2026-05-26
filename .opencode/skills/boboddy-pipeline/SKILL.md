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
2. Create or edit a `.ts` file inside `.boboddy/pipeline-builder/`. Each file must export a default `definePipeline(...)`.
3. Present the pipeline definition to the user for review. Summarize the steps, signals, input bindings, and advancement rules so the user can verify intent without re-reading the file.
4. Wait for explicit approval. Do not run `boboddy pipelines push` until the user confirms. If they request changes, iterate on the file and re-surface for review.
5. Once approved, ask whether the user wants to push themselves or have me push. Only run `boboddy pipelines push` (or `boboddy pipelines push <projectId>`) if they choose the latter. The CLI auto-pushes any step definitions it finds in the same directory first.

---

## Imports

```typescript
import { z } from "zod";
import { defineStep, Features } from "@boboddy/sdk/definitions/steps";
import {
  definePipeline,
  Rule,
  fromPipelineInput,
  fromSignal,
  stepOutput,
} from "@boboddy/sdk/definitions/pipelines";
```

---

## Defining steps

Each step represents one unit of agent work. Define every step before `definePipeline`.

```typescript
export const myStep = defineStep({
  key: "my-step",           // lowercase kebab-case, unique per project
  name: "My Step",          // display name
  description: "...",       // optional
  version: 1,               // increment when schema changes
  status: "active",         // "draft" | "active" (default: "active")

  prompt: "You are ...",    // the LLM system prompt for this step

  // Zod schema for what the step receives
  input: z.object({
    content: z.string(),
  }),

  // Zod schema for what the step produces
  result: z.object({
    summary: z.string(),
    confidence: z.number(),
    approved: z.boolean(),
  }),

  // Signals: named values extracted from the result for use in advancement rules
  // and as bindings for downstream steps.
  // key defaults to sourcePath if omitted.
  // type is inferred from the result schema if omitted.
  signals: [
    { sourcePath: "confidence" },        // key = "confidence", type = "number"
    { key: "ok", sourcePath: "approved" }, // explicit key
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

### Computed signals
Aggregate multiple signals into one:
```typescript
computedSignals: [
  {
    key: "avg-score",
    type: "average",           // "average" | "weighted_average" | "sum" | "min" | "max" | "custom"
    inputSignalKeys: ["score1", "score2"],
  },
],
```

### `Features.feedbackRequests()`
Adds a `feedbackRequests?: FeedbackRequestItem[]` field to the result and injects a prompt instructing the agent to surface questions for human review. Use when a step may need to escalate unclear cases.

---

## Defining a pipeline

```typescript
export default definePipeline({
  key: "my-pipeline",     // lowercase kebab-case, unique per project
  name: "My Pipeline",
  description: null,      // optional
  version: 1,
  status: "active",       // "draft" | "active" (default: "active")
  steps: [
    // Step configs — ordered, 1-indexed positions assigned automatically
    { step: stepOne, input: { ... }, advancement: { ... } },
    { step: stepTwo, input: { ... } },
  ],
});
```

---

## Step config: input bindings

Each step config has an optional `input` map that wires values into the step's input fields.

### `fromPipelineInput(schema, path)` — pipeline-level input
```typescript
const pipelineInput = z.object({ body: z.string(), userId: z.string() });

{
  step: investigate,
  input: {
    content: fromPipelineInput(pipelineInput, "body"),
    // nested paths also work: fromPipelineInput(pipelineInput, "meta.id")
  },
}
```

### `fromSignal(priorStep, signalKey)` — use a named signal from an earlier step
```typescript
{
  step: triage,
  input: {
    confidence: fromSignal(investigate, "confidence"),
  },
}
```
`signalKey` is TypeScript-validated against the prior step's declared signals.

### `stepOutput(priorStep)` — bind the entire result object of a prior step
```typescript
{
  step: report,
  input: {
    data: stepOutput(investigate),
  },
}
```
Prefer `fromSignal` for stability; use `stepOutput` when you need the full object.

---

## Step config: advancement policy

Controls how a step transitions after the agent completes. Omitting `advancement` defaults to `{ defaultOutcome: "continue" }`.

```typescript
advancement: {
  defaultOutcome: "block",   // outcome when no rules match
  rules: [                   // evaluated in order; first match wins
    Rule.when("confidence", "greaterThanInclusive", 0.8, "continue"),
  ],
}
```

### Outcomes
| Outcome | Meaning |
|---|---|
| `"continue"` | Advance to the next step automatically |
| `"block"` | Pause; wait for human intervention |
| `"needs_review"` | Flag for review before proceeding |
| `"complete"` | End the pipeline here |

Attach extra context with object form:
```typescript
{ outcome: "needs_review", outcomeJson: { reason: "low confidence" } }
```

### Rule builders

**`Rule.when`** — single-condition shorthand:
```typescript
Rule.when("score", "greaterThanInclusive", 80, "continue")
```

**`Rule.all`** — all conditions must match:
```typescript
Rule.all([
  Rule.signal("score", "greaterThanInclusive", 80),
  Rule.signal("flagged", "equal", false),
], "continue")
```

**`Rule.any`** — any condition must match:
```typescript
Rule.any([
  Rule.signal("score", "greaterThan", 95),
  Rule.signal("override", "equal", true),
], "continue")
```

**Nesting** — `Rule.all` / `Rule.any` can be nested inside each other:
```typescript
Rule.all([
  Rule.signal("score", "greaterThanInclusive", 80),
  Rule.any([
    Rule.signal("reviewerApproved", "equal", true),
    Rule.signal("autoApproved", "equal", true),
  ]),
], "continue")
```

### Operators
`equal` · `notEqual` · `lessThan` · `lessThanInclusive` · `greaterThan` · `greaterThanInclusive` · `in` · `notIn` · `contains` · `doesNotContain`

---

## Complete example

```typescript
import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";
import {
  definePipeline,
  Rule,
  fromPipelineInput,
  fromSignal,
} from "@boboddy/sdk/definitions/pipelines";

const pipelineInput = z.object({ issueBody: z.string() });

export const investigate = defineStep({
  key: "investigate",
  name: "Investigate",
  version: 1,
  prompt: "You are an expert investigator. Analyze the issue and assess confidence.",
  input: z.object({ content: z.string() }),
  result: z.object({ summary: z.string(), confidence: z.number() }),
  signals: [{ sourcePath: "confidence" }],
});

export const triage = defineStep({
  key: "triage",
  name: "Triage",
  version: 1,
  prompt: "Given the investigation summary, assign a priority level: low, medium, or high.",
  input: z.object({ summary: z.string() }),
  result: z.object({ priority: z.string() }),
  signals: [{ sourcePath: "priority" }],
});

export default definePipeline({
  key: "issue-pipeline",
  name: "Issue Pipeline",
  version: 1,
  steps: [
    {
      step: investigate,
      input: { content: fromPipelineInput(pipelineInput, "issueBody") },
      advancement: {
        defaultOutcome: "block",
        rules: [Rule.when("confidence", "greaterThanInclusive", 0.8, "continue")],
      },
    },
    {
      step: triage,
      input: { summary: fromSignal(investigate, "summary") },
    },
  ],
});
```

Wait — `summary` is on the result, not declared as a signal above. To use `fromSignal`, the field must appear in `signals`. To pass `summary` without declaring it as a signal, use `stepOutput(investigate)` and let the triage step unpack it, or add `{ sourcePath: "summary" }` to `investigate`'s signals.

---

## Deploying

Only push after the user has reviewed and approved the pipeline definition. Once approved, ask whether the user wants to push themselves or wants me to run the push.

```bash
# First time setup (creates .boboddy/pipeline-builder/ with example files)
boboddy pipelines init

# Push all pipeline definitions (also pushes step definitions automatically)
boboddy pipelines push

# Push to a specific project
boboddy pipelines push <projectId>
```

Steps referenced in a pipeline must exist on the server. The `push` command handles this automatically by pushing all step definitions found in `.boboddy/pipeline-builder/` before pushing pipelines.

Incrementing `version` in `defineStep` or `definePipeline` creates a new entity on the server rather than updating the existing one.
