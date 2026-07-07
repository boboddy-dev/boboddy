---
title: SDK Reference
description: TypeScript SDK types, helpers, and API client
---

Install the SDK:

```bash
npm install @boboddy/sdk
# or
bun add @boboddy/sdk
```

---

## `defineStep(options)`

Define a reusable, versioned step with typed input/output schemas.

```typescript
import { defineStep } from "@boboddy/sdk";
import { z } from "zod";

const myStep = defineStep({
  key: "my-step",
  name: "My Step",
  version: 1,
  description: "Does something useful.",
  additionalInput: z.object({ text: z.string() }),
  result: z.object({ summary: z.string(), score: z.number() }),
  signals: [
    {
      sourcePath: "score",
      key: "quality_score",
      type: "number",
      required: true,
    },
  ],
  agentPrompt: ({ input, env, boboddy }) => `
Analyze the provided text from ${input.text}.
Base URL: ${env.BASE_URL}
Write any generated files to ${boboddy.artifactsDir}
Return a summary and quality score.
`,
  status: "active",
});
```

### `StepDefinition` options

| Field             | Type                              | Required | Description                                                               |
| ----------------- | --------------------------------- | -------- | ------------------------------------------------------------------------- |
| `key`             | `string`                          | Yes      | Unique step key within the project                                        |
| `name`            | `string`                          | Yes      | Display name                                                              |
| `version`         | `number`                          | No       | Version (default: `1`)                                                    |
| `description`     | `string`                          | No       | Short description                                                         |
| `agentPrompt`     | `string \| ((context) => string)` | Yes      | AI instruction given to the executing agent                               |
| `additionalInput` | `ZodType`                         | No       | Additional input payload schema; fields are bound via the pipeline mapper |
| `result`          | `ZodType`                         | No       | Output payload schema                                                     |
| `signals`         | `Signal[]`                        | No       | Values to extract from the result                                         |
| `mcpServers`      | `OpenCodeMcpServers`              | No       | MCP server configs for tool-using agents                                  |
| `status`          | `"draft" \| "active"`             | No       | Draft steps are skipped by workers                                        |
| `executionMode`   | `"workspace" \| "no_workspace"`   | No       | `"no_workspace"` runs the agent without cloning your repo or a dev container; defaults to `"workspace"`. See [Execution mode](/boboddy/guides/steps/#execution-mode) |

### `agentPrompt`

`agentPrompt` accepts either a raw string or a function that receives a typed prompt context. The function form is recommended because it gives autocomplete for supported prompt variables and keeps prompt tokens consistent with your step schema.

```typescript
const browserReproStep = defineStep({
  key: "browser-repro",
  name: "Browser Repro",
  additionalInput: z.object({
    title: z.string(),
    description: z.string(),
  }),
  agentPrompt: ({ input, env, boboddy }) => `
Open ${env.BASE_URL}.
Reproduce the issue described in ${input.title}.
Save traces to ${boboddy.artifactsDir}trace.zip.
`,
});
```

#### Prompt context scopes

| Scope     | Example                   | Source                                                   |
| --------- | ------------------------- | -------------------------------------------------------- |
| `input`   | `${input.title}`          | Step execution input bound through the pipeline          |
| `env`     | `${env.BASE_URL}`         | Any defined environment variable available to the worker |
| `boboddy` | `${boboddy.artifactsDir}` | Boboddy-provided runtime values                          |

At runtime these become `{{input.title}}`, `{{env.BASE_URL}}`, and `{{boboddy.artifactsDir}}` inside the stored prompt template.

Boboddy currently provides:

- `boboddy.artifactsDir` for files that should be uploaded as step artifacts.

Legacy raw prompt tokens such as `{{title}}` and `{{stepArtifactsDir}}` still resolve, but new steps should prefer the scoped form.

### `Signal`

```typescript
type Signal = {
  sourcePath: string; // dot-notation path into result, e.g. "metrics.score"
  key?: string; // signal name used in advancement rules (defaults to sourcePath)
  type?: "number" | "string" | "boolean" | "object" | "array";
  required?: boolean; // fail execution if signal is missing
};
```

---

## `pipeline(meta)`

Define an ordered sequence of steps using the fluent builder.

```typescript
import { pipeline } from "@boboddy/sdk/definitions/pipelines";
import { z } from "zod";

const inputSchema = z.object({ text: z.string() });

const myPipeline = pipeline({
  key: "my-pipeline",
  name: "My Pipeline",
  status: "active",
  additionalPipelineInput: {
    schema: z.object({ text: z.string() }),
    bindings: ({ workItem }) => ({ text: workItem.field("Text") }),
  },
})
  .step(myStep, ({ input }) => ({ text: input.text }))
  .advance(() => ({ default: "continue" }))
  .build();
```

### `PipelineMeta` options

| Field                     | Type                  | Required | Description                                                |
| ------------------------- | --------------------- | -------- | ---------------------------------------------------------- |
| `key`                     | `string`              | Yes      | Unique pipeline key                                        |
| `name`                    | `string`              | Yes      | Display name                                               |
| `version`                 | `number`              | No       | Version (default: `1`)                                     |
| `description`             | `string`              | No       | Short description                                          |
| `status`                  | `"draft" \| "active"` | No       | Draft pipelines are not executed                           |
| `additionalPipelineInput` | `object`              | No       | Custom input fields; requires both `schema` and `bindings` |
| `additionalStepInput`     | `object`              | No       | Default bindings applied to every step in the pipeline     |

`additionalPipelineInput.schema` is a Zod object schema for extra pipeline input fields. `additionalPipelineInput.bindings` receives `{ workItem, literal }` and returns their bindings.

`additionalStepInput` applies default bindings to every step in the pipeline. Its `bindings` function receives `{ workItemField, literal }` and compiles into regular step input bindings. Explicit `.step(..., mapper)` bindings override pipeline-level defaults.

### Builder methods

| Method                           | Description                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.step(step, mapper, configFn?)` | Append a step. `mapper` receives `{ input, signal, output, literal }` and returns a record of input bindings keyed by the step's input fields. Optional `configFn` receives `{ timeout }` — set `cfg.timeout` (seconds) to cap execution time.                                                 |
| `.advance(callback)`             | Attach an advancement policy to the most recently added step. `callback` receives `{ signal, stepSignals, all, any, route, avg, sum, min, max, count, weightedAvg, booleanAny, booleanAll }` and returns `{ default, rules? }`. **Required** before adding another step or calling `.build()`. |
| `.build()`                       | Finalize and return a `PipelineDefinitionSpec`.                                                                                                                                                                                                                                                |

### Step input bindings

Inside the `.step()` mapper:

- **`input.workItemTitle`** / **`input.workItemDescription`** — always available; bind to the work item title or description.
- **`input.<path>`** — custom fields from `additionalPipelineInput.schema`. `input.code` binds to path `"code"`; `input.ticket.title` binds to `"ticket.title"`. The accessor is a proxy — do not spread or coerce it to a primitive.
- **`signal(step, signalKey)`** — bind to a prior step's signal. `signalKey` is typed against `step.__signalKeys`.
- **`output(step)`** — bind to a prior step's whole output object.
- **`literal(value)`** — a hardcoded constant.

### Fluent advancement rules

Inside the `.advance()` callback:

- **`signal(key)`** — returns a typed `SignalRef` for the current step's signal. Chain a comparator (`.eq`, `.gt`, `.gte`, `.lt`, `.lte`, `.ne`, `.in`, `.notIn`, `.contains`, `.doesNotContain`) followed by `.then(outcome)`.
- **`stepSignals.<key>`** — property-map shorthand equivalent to `signal(key)`. Both produce identical output.
- **Computed factories** — `avg`, `weightedAvg`, `sum`, `min`, `max`, `count`, `booleanAny`, `booleanAll`. Each takes 2+ `signal(key)` or `stepSignals.key` references and returns a `SignalRef`. Identical calls across rules are deduplicated at build time.
- **`all(...refs)` / `any(...refs)`** — group `SignalRef`s and other groups; terminate with `.then(outcome)`.
- **`route(pipelineKey, inputJson?)`** — produces a route outcome value for `.then(...)`.

---

## `defaultPipelineAssignment(callback)`

Define which pipeline is automatically started when a work item arrives. This goes in the reserved file `.boboddy/pipeline-builder/default-pipeline-assignment.ts`.

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
    workItem
      .field("labels")
      .contains("regression")
      .then(assign(regressionReview)),
  ],
}));
```

The callback receives a context object. Only `defaultPipelineAssignment` needs to be imported.

### Callback context

| Property               | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `workItem.field(name)` | Returns a comparator ref for the named work item field       |
| `context.isNew`        | Comparator ref; `true` when the work item is new             |
| `assign(pipeline)`     | Outcome: start the given pipeline (`PipelineDefinitionSpec`) |
| `skip()`               | Outcome: do not assign any pipeline                          |
| `all(...refs)`         | All nested conditions must match                             |
| `any(...refs)`         | Any nested condition must match                              |

### Return value shape

| Field     | Type                           | Description                                                  |
| --------- | ------------------------------ | ------------------------------------------------------------ |
| `default` | `AssignOutcome \| SkipOutcome` | Outcome when no rule matches; `assign(pipeline)` or `skip()` |
| `rules`   | `AssignmentRule[]`             | Ordered rules; first match wins                              |

### Comparators

All comparators available on advancement `SignalRef`s are also available here: `.eq`, `.ne`, `.gt`, `.gte`, `.lt`, `.lte`, `.in`, `.notIn`, `.contains`, `.doesNotContain`.

---

## API client

The SDK ships an auto-generated API client built from the OpenAPI spec.

```typescript
import { createBoboddyClient } from "@boboddy/sdk";

const client = createBoboddyClient("https://app.boboddy.dev");
```

Use `createStepDefinitionsClient` for CRUD operations on step definitions:

```typescript
import { createStepDefinitionsClient } from "@boboddy/sdk";

const stepClient = createStepDefinitionsClient("https://app.boboddy.dev");
```

---

## Config helpers

### JSONC parser

Parse `.boboddy/boboddy.jsonc` files (JSON with comments):

```typescript
import { parseJsonc } from "@boboddy/sdk";

const config = parseJsonc(rawString);
```

### Project config

Read the Boboddy project config from disk. `readProjectConfig` is exported from `@boboddy/worker` (not the SDK):

```typescript
import { readProjectConfig } from "@boboddy/worker";

const { projectId } = await readProjectConfig();
```
