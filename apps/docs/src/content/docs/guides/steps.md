---
title: Defining Steps
description: Create reusable, versioned computation units with typed inputs, outputs, and signals
---

A **step** is the atomic unit of work in Boboddy. Each step has a typed input schema, a result schema, an agent prompt, and optionally a set of **signals** extracted from its output.

## Basic step

```typescript
import { defineStep } from "@boboddy/sdk";
import { z } from "zod";

export const summarizeStep = defineStep({
  key: "summarize-text",
  name: "Summarize Text",
  agentPrompt: "Summarize the provided text concisely.",
  additionalInput: z.object({
    text: z.string(),
  }),
  result: z.object({
    summary: z.string(),
  }),
  status: "active",
});
```

The agent is automatically given the step's input as default context — the full input JSON is injected into the prompt when the step runs. You do **not** need to interpolate fields like `input.text` into `agentPrompt` for the agent to see them. Referencing input fields (see [Prompt context](#prompt-context)) is optional and only inlines a specific value into your instructions.

## `defineStep` options

| Field             | Type                              | Required | Description                                                                     |
| ----------------- | --------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `key`             | `string`                          | Yes      | Unique identifier for this step within the project                              |
| `name`            | `string`                          | Yes      | Human-readable display name                                                     |
| `version`         | `number`                          | No       | Version number (defaults to 1)                                                  |
| `description`     | `string`                          | No       | Brief description shown in the UI                                               |
| `agentPrompt`     | `string \| ((context) => string)` | Yes      | AI prompt given to the worker agent when executing this step                    |
| `additionalInput` | `ZodType`                         | No       | Zod schema for the step's additional input fields; bound in the pipeline mapper |
| `result`          | `ZodType`                         | No       | Zod schema for the step's output                                                |
| `signals`         | `Signal[]`                        | No       | Values to extract from the result for pipeline advancement logic                |
| `mcpServers`      | `OpenCodeMcpServers`              | No       | MCP server configurations for tool-using agents                                 |
| `plugins`         | `OpenCodePluginEntry[]`           | No       | Opencode plugins merged into the generated config when this step runs           |
| `features`        | `StepFeature[]`                   | No       | Built-in feature plugins that extend the result schema, signals, and prompt     |
| `status`          | `"draft" \| "active"`             | No       | Draft steps are not executed; defaults to `"active"`                            |
| `executionMode`   | `"workspace" \| "no_workspace"`   | No       | Whether the step needs your repository. Defaults to `"workspace"`               |

## Prompt context

`agentPrompt` can be a raw string, but the recommended form is a function that receives a typed prompt context. This gives autocomplete for step input fields and supported runtime variables.

```typescript
export const browserReproStep = defineStep({
  key: "browser-repro",
  name: "Browser Repro",
  additionalInput: z.object({
    title: z.string(),
  }),
  agentPrompt: ({ input, env, boboddy }) => `
Open ${env.BASE_URL}.
Investigate the issue titled ${input.title}.
Save traces and screenshots to ${boboddy.artifactsDir}.
`,
});
```

Available scopes:

| Scope     | Use for                                                         |
| --------- | --------------------------------------------------------------- |
| `input`   | Fields from `additionalInput` and any pipeline-bound step input |
| `env`     | Any defined environment variable available to the worker        |
| `boboddy` | Boboddy-provided runtime values                                 |

Boboddy currently provides `boboddy.artifactsDir`, which points to the directory whose contents will be uploaded as step artifacts after the run.

The function form compiles to the same template syntax Boboddy stores internally, such as `{{input.title}}` and `{{env.BASE_URL}}`. Existing raw tokens still work, but new steps should prefer scoped variables.

## Signals

Signals are scalar values (numbers, strings, booleans) extracted from the step result. They drive pipeline advancement policies — e.g., "only advance to the next step if `clarity_score` is above 7".

```typescript
export const reviewStep = defineStep({
  key: "code-review",
  name: "Code Review",
  result: z.object({
    feedback: z.string(),
    quality: z.number(),
    security: z.number(),
  }),
  signals: [
    {
      sourcePath: "quality",
      key: "quality_score",
      type: "number",
      required: true,
    },
    {
      sourcePath: "security",
      key: "security_score",
      type: "number",
      required: true,
    },
  ],
  // ...
});
```

### Signal options

| Field        | Type                                | Description                                                        |
| ------------ | ----------------------------------- | ------------------------------------------------------------------ |
| `sourcePath` | `string`                            | Dot-notation path into the result object (e.g., `"metrics.score"`) |
| `key`        | `string`                            | Signal name used in pipeline advancement rules                     |
| `type`       | `"number" \| "string" \| "boolean"` | Expected type                                                      |
| `required`   | `boolean`                           | If true, a missing value causes the execution to fail              |

## Computed signals

Computed signals aggregate multiple raw signals into a single derived value.

```typescript
computedSignals: [
  {
    key: 'average_score',
    type: 'average',
    inputSignalKeys: ['quality_score', 'security_score'],
  },
],
```

## MCP servers

Steps can be given access to MCP (Model Context Protocol) servers, giving the agent tools like database access, browser automation, or custom APIs. `mcpServers` is a record keyed by server name. Each value is one of three shapes: a **local** server, a **remote** server, or an **enabled override**.

### Local servers

A local server is launched as a subprocess. `command` is an **array** — the executable followed by its arguments (there is no separate `args` field).

```typescript
mcpServers: {
  postgres: {
    type: "local",
    command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
    environment: { DATABASE_URI: "{env:DATABASE_URI}" },
    enabled: true,
  },
},
```

| Field         | Type                     | Required | Description                                                        |
| ------------- | ------------------------ | -------- | ------------------------------------------------------------------ |
| `type`        | `"local"`                | Yes      | Marks a locally launched server                                    |
| `command`     | `string[]`               | Yes      | Executable plus arguments; must have at least one entry            |
| `environment` | `Record<string, string>` | No       | Environment variables. `{env:VAR}` interpolates a worker env var   |
| `enabled`     | `boolean`                | No       | Set `false` to define but disable the server                       |
| `timeout`     | `number`                 | No       | Startup/request timeout in milliseconds                            |

### Remote servers

A remote server is reached over HTTP.

```typescript
mcpServers: {
  docs: {
    type: "remote",
    url: "https://mcp.example.com/sse",
    headers: { Authorization: "Bearer {env:MCP_TOKEN}" },
    enabled: true,
  },
},
```

| Field     | Type                          | Required | Description                                              |
| --------- | ----------------------------- | -------- | -------------------------------------------------------- |
| `type`    | `"remote"`                    | Yes      | Marks a remote HTTP server                               |
| `url`     | `string`                      | Yes      | Server URL                                               |
| `headers` | `Record<string, string>`      | No       | Extra request headers                                    |
| `oauth`   | `object \| false`             | No       | OAuth config (`clientId`, `clientSecret`, `scope`, `redirectUri`), or `false` to disable |
| `enabled` | `boolean`                     | No       | Set `false` to define but disable the server             |
| `timeout` | `number`                      | No       | Request timeout in milliseconds                          |

### Enabled override

To toggle an inherited server without redefining it, pass just `enabled`:

```typescript
mcpServers: {
  postgres: { enabled: false },
},
```

## Plugins

Attach Opencode plugins to a step with `plugins`. When the step runs, Boboddy merges these into the generated Opencode config for that execution. Use plain package names, or the `[packageName, options]` tuple form when a plugin needs configuration.

```typescript
export const investigateStep = defineStep({
  key: "bad-data-investigation",
  name: "Bad Data Investigation",
  agentPrompt: "Investigate the reported data issue.",
  plugins: ["@datadog/opencode-plugin"],
});
```

Plugin entries are deduplicated by package name when Boboddy combines your baseline Opencode config with the step-specific plugins.

## Features

`features` adds built-in **feature plugins** to a step. Each feature extends the step's `result` schema, appends signals, and injects supporting text into the prompt — so you get a consistent, typed convention without hand-writing the schema, signals, and instructions yourself.

```typescript
import { defineStep, Features } from "@boboddy/sdk/definitions/steps";

export const reproStep = defineStep({
  key: "browser-reproduction",
  name: "Browser Reproduction",
  agentPrompt: "Reproduce the reported bug.",
  result: z.object({ reproduced: z.boolean() }),
  features: [Features.notifications()],
});
```

### `Features.notifications()`

Adds a `$boboddy_notifications_v1` array to the result and a matching (optional) signal, plus prompt text instructing the agent how to surface messages for humans. Use it whenever a step may need to escalate a question, report a block, or flag a warning.

Each notification item has:

| Field               | Type                                                                        | Required | Description                                                        |
| ------------------- | --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `kind`              | `"feedback_request" \| "status_update" \| "blocked" \| "result_ready" \| "warning"` | Yes | The kind of notification                                           |
| `title`             | `string`                                                                    | Yes      | Short, human-readable title                                        |
| `body`              | `string`                                                                    | Yes      | Notification details                                               |
| `priority`          | `"low" \| "normal" \| "high" \| "urgent"`                                   | Yes      | How important the notification is                                  |
| `suggestedChannels` | `("in_app" \| "work_item_platform_comment" \| "email" \| "slack")[]`        | No       | Channels the agent suggests; the platform policy decides the final channels |
| `payload`           | `Record<string, unknown>`                                                   | No       | Kind-specific data. For `feedback_request`: `{ category, urgency, suggestedKey? }` |

The feature contributes a single signal, `$boboddy_notifications_v1` (type `array`, not required), so downstream advancement rules can react to emitted notifications.

### `Features.feedbackRequests()`

A convenience wrapper over `Features.notifications()`, backed by the same `$boboddy_notifications_v1` signal. Use it when a step's primary escalation path is asking the project team clarifying questions.

## Execution mode

`executionMode` controls whether a step needs a checkout of your repository to do its work.

| Mode            | What the worker sets up                                                                                          | Use for                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `"workspace"`   | Clones your repository and launches your `.devcontainer/devcontainer.json`; the agent runs **inside** that container. | Steps that read, run, or modify your code (default).                       |
| `"no_workspace"`| No clone and no dev container. The agent runs against a temporary empty directory with only the prompt and its bound input. | Prompt-only steps — research, summarization, drafting, classification, or routing decisions. |

```typescript
export const classifyStep = defineStep({
  key: "classify-ticket",
  name: "Classify Ticket",
  executionMode: "no_workspace",
  additionalInput: z.object({ title: z.string(), body: z.string() }),
  result: z.object({ category: z.string() }),
  agentPrompt: ({ input }) =>
    `Classify this ticket into a single category:\n\n${input.title}\n${input.body}`,
});
```

`no_workspace` steps are faster and cheaper because they skip the clone and container startup, and they run even for projects without a dev container. Everything else works the same — bound input, `agentPrompt`, `result`, `signals`, and `mcpServers` all behave identically. Because there is no checkout, the agent has no access to your repository files; if a step needs to read or change your code, keep it on the default `"workspace"` mode.

See [Running Workers](/boboddy/guides/workers/) for how each mode is executed.

Increment `version` when you make a breaking change to a step's schema or prompt. Old executions referencing version 1 continue using the v1 definition; new executions pick up v2.

```typescript
export const reviewStep = defineStep({
  key: "code-review",
  version: 2,
  // ...
});
```

## Pushing steps

Steps are pushed together with pipeline definitions using a single command from `.boboddy/pipeline-builder/`:

```bash
boboddy pipelines push
```

This pushes all steps exported from `steps.ts` (and any steps embedded in pipeline files) before pushing the pipeline definitions. The `key` + `version` pair uniquely identifies each step definition on the server.
