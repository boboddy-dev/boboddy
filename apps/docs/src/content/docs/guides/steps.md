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
| `healthChecks`    | `HealthCheck[]`                   | No       | Real tool calls forced against the environment before the agent is prompted     |
| `plugins`         | `OpenCodePluginEntry[]`           | No       | Opencode plugins merged into the generated config when this step runs           |
| `features`        | `StepFeature[]`                   | No       | Built-in feature plugins that extend the result schema, signals, and prompt     |
| `status`          | `"draft" \| "active"`             | No       | Draft steps are not executed; defaults to `"active"`                            |
| `environment`     | `{ runtime?, vars?, repo? }`      | No       | Where the step runs, which environment variables it gets, and what it does to your repository. Declare it before `agentPrompt`. See [Environment](#environment) |

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
| `env`     | The worker's environment, or the step's `environment.vars` (below) |
| `boboddy` | Boboddy-provided runtime values                                 |

Boboddy currently provides `boboddy.artifactsDir`, which points to the directory whose contents will be uploaded as step artifacts after the run.

The function form compiles to the same template syntax Boboddy stores internally, such as `{{input.title}}` and `{{env.BASE_URL}}`. Existing raw tokens still work, but new steps should prefer scoped variables.

In a step that does not declare [`environment.vars`](#environment-variables), `env` is the worker's environment: `.boboddy/.env` merged over the worker's `process.env`. Once a step declares `vars`, the prompt's `env` is **strict** — only the declared, non-secret keys, and nothing else from the worker.

## Environment

`environment` describes how a step runs: **where** it runs (`runtime`), **which environment variables** it gets (`vars`), and **what it does to your repository** (`repo`). It is accepted by `defineStep()` and [`codeStep()`](#code-steps), and every field is optional.

```typescript
import { defineStep, Runtime, Env } from "@boboddy/sdk";
import { z } from "zod";

export const buildFrontend = defineStep({
  key: "build-frontend",
  name: "Build Frontend",
  additionalInput: z.object({ targetUrl: z.string() }),
  environment: {
    runtime: Runtime.devcontainer({
      config: ".devcontainer/frontend/devcontainer.json",
    }),
    vars: ({ input }) => ({
      TARGET_URL: input.targetUrl,
      PROFILER_TOKEN: Env.inherit({ secret: true }),
    }),
  },
  agentPrompt: ({ env }) => `Build the frontend and profile ${env.TARGET_URL}.`,
});
```

| Field                 | Type                                                   | Default                  |
| --------------------- | ------------------------------------------------------ | ------------------------ |
| `environment.runtime` | `Runtime.devcontainer({ config? })` or `Runtime.host()` | `Runtime.devcontainer()` |
| `environment.vars`    | `({ input }) => Record<string, string \| EnvEntry>`     | none                     |
| `environment.repo`    | `Repo.readWrite()`, `Repo.readOnly()` or `Repo.none()`, or `({ input, result }) => RepoSpec` | The runtime's default (see [Repo access](#repo-access)) |

:::caution
Declare `environment` **before** `agentPrompt`. TypeScript infers the keys declared in `vars` into the prompt's `env`, so `environment` has to come first in the object for `agentPrompt`'s `env` to be typed from it.
:::

### Runtime

`runtime` controls whether a step gets a checkout of your repository, and which container it runs in.

| Runtime                    | What the worker sets up                                                                                                | Use for                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Runtime.devcontainer()`   | Clones your repository and launches your devcontainer; the agent runs **inside** that container. This is the default.  | Steps that read, run, or modify your code.                                                     |
| `Runtime.host()`           | No clone and no dev container. The agent runs on the worker host against a temporary empty directory with only the prompt and its bound input. | Prompt-only steps: research, summarization, drafting, classification, or routing decisions. |

```typescript
import { defineStep, Runtime } from "@boboddy/sdk";
import { z } from "zod";

export const classifyStep = defineStep({
  key: "classify-ticket",
  name: "Classify Ticket",
  environment: { runtime: Runtime.host() },
  additionalInput: z.object({ title: z.string(), body: z.string() }),
  result: z.object({ category: z.string() }),
  agentPrompt: ({ input }) =>
    `Classify this ticket into a single category:\n\n${input.title}\n${input.body}`,
});
```

`Runtime.host()` steps are faster and cheaper because they skip the clone and container startup, and they run even for projects without a dev container. Everything else works the same: bound input, `agentPrompt`, `result`, `signals`, and `mcpServers` all behave identically. Because there is no checkout, the agent has no access to your repository files; if a step needs to read or change your code, keep the default `Runtime.devcontainer()`. `Runtime.host()` takes no options, so a host step cannot name a devcontainer config.

See [Running Workers](/boboddy/guides/workers/) for how each runtime is executed.

#### Selecting a devcontainer config

By default the worker launches `.devcontainer/devcontainer.json`, falling back to `devcontainer.json` at the repository root. A repository can keep more than one config (a frontend image, a perf image, a CI image); pass `config` to pick one for a step:

```typescript
environment: {
  runtime: Runtime.devcontainer({
    config: ".devcontainer/frontend/devcontainer.json",
  }),
},
```

`config` is the **full repo-relative path** to the file. There is no name shorthand.

- The file name must be `devcontainer.json` or `.devcontainer.json`. This is the devcontainer CLI's own rule for `--config`.
- The path must be relative to the repository root: no leading `/`, no drive letter, no backslashes, and no `..` segment. A leading `./` is stripped. It can be at most 255 characters.
- These rules are checked when you define the step (`Runtime.devcontainer` throws), by `boboddy pipelines push` validation, by the server (a `422`), and again by the worker before launch.

An explicit `config` has **no fallback**. The worker does not go looking for another config if yours is missing, because that would run the step in a different container than the one you chose. If the file does not exist, the step fails before the container launches:

```
Devcontainer config ".devcontainer/frontend/devcontainer.json" not found in the cloned repository (branch "main")
```

The error names the path and the branch it was looked up on.

:::note[The config comes from the branch the step is based on]
The worker reads the config from the checkout the step starts from. For the first step in a pipeline that is your base branch (see [Base branch](/boboddy/guides/workers/#base-branch)); for a later step it is the work branch of the nearest earlier step that produced one. So an earlier step can add, change, or remove a config that a later step selects. The config must exist on that branch, not only on your default branch.
:::

The worker patches the config it launches (to add mounts, ports, and `containerEnv`). That patched file is **not** committed to the step's work branch, wherever it lives. See [Setting up a Dev Container](/boboddy/guides/devcontainer/#multiple-configs) for writing an alternate config.

#### Runtime for code steps

[`codeStep()`](#code-steps) takes the same `environment`, with one restriction: **`Runtime.host()` is not supported**. A code step runs code from your repository, and the host runtime has no clone, so the entrypoint could never be found. This is a type error on `codeStep`, and `boboddy pipelines push` validation rejects a hand-built spec that does it.

A code step runs in whichever container its runtime selects, and the runner script executes there. For any non-default `config`, the container must provide a JavaScript runtime for that script. That is up to the author of the config.

### Repo access

`repo` controls what the worker does with the repository clone: whether the step gets a [work branch](/boboddy/guides/workers/#work-branches), and whether its changes are committed and pushed. Pick one of three modes:

| Mode                | What the worker does                                                                                                                  | Use for                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Repo.readWrite()`  | Creates a work branch, then commits the agent's changes and pushes the branch when the step succeeds. This is the devcontainer default. | Steps that change code.                                       |
| `Repo.readOnly()`   | Clones and checks out the base branch, but creates no work branch, commits nothing, pushes nothing, and reports no `workBranch`.       | Steps that only read code: triage, analysis, review.          |
| `Repo.none()`       | No repository. The worker does not clone, branch, commit, or push. This is the `Runtime.host()` default.                               | Prompt-only steps on `Runtime.host()`.                        |

Which modes a runtime accepts, and its default:

| Runtime                  | `readWrite`            | `readOnly`             | `none`                                       | Default     |
| ------------------------ | ---------------------- | ---------------------- | -------------------------------------------- | ----------- |
| `Runtime.devcontainer()` | Yes                    | Yes                    | No: the config is read from the clone        | `readWrite` |
| `Runtime.host()`         | No: there is no clone  | No: there is no clone  | Yes                                          | `none`      |

A pair the runtime does not accept is a type error where TypeScript can express it. `boboddy pipelines push` validation and the server (a `422`) reject it otherwise. A step that omits `repo` gets its runtime's default, so `Repo.readWrite()` on a devcontainer step and `Repo.none()` on a host step are redundant. [`codeStep()`](#code-steps) accepts `repo` with the same rules.

```typescript
import { defineStep, Repo } from "@boboddy/sdk";
import { z } from "zod";

export const triage = defineStep({
  key: "triage",
  name: "Triage",
  environment: { repo: Repo.readOnly() },
  agentPrompt: "Find the code behind this report and summarize it.",
});

export const implement = defineStep({
  key: "implement",
  name: "Implement",
  additionalInput: z.object({ title: z.string() }),
  result: z.object({ summary: z.string() }),
  environment: {
    repo: ({ result }) =>
      Repo.readWrite({ message: `fix: ${result.summary}` }),
  },
  agentPrompt: ({ input }) => `Fix: ${input.title}`,
});
```

#### `Repo.readWrite` options

| Option          | Type                  | Default                          | Description                                                                                      |
| --------------- | --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `message`       | `string`              | `boboddy: step <stepExecutionId>` | The commit message, rendered from the step's input and result                                    |
| `onPushFailure` | `"fail" \| "warn"`    | `"fail"`                         | Whether a failed push fails the step (`"fail"`) or is logged and ignored (`"warn"`)              |

**Commit message.** `repo` is a function of `{ input, result }`, the same way `vars` is a function of `{ input }`: both are typed from the step's `additionalInput` and `result`, and a template literal built from them (`` `fix: ${result.summary}` ``) becomes a `{{result.summary}}` token that the worker renders when the step finishes. Write the string with a prefix before the interpolation, since a bare `` `${result.summary}` `` trips a lint rule. A static `Repo.readWrite({ message: "fix: {{result.summary}}" })` is the same thing, and the common case when the message needs no tokens.

- Only `{{input.…}}` and `{{result.…}}` tokens are allowed. `{{env.…}}` is rejected, so an environment value can never reach git history.
- The template is one line and at most 500 characters.
- The rendered text carries agent output, so the worker reduces it to a safe subject: whitespace runs collapse to one space, control characters are stripped, and the subject is cut to 200 characters. If nothing is left (an empty template, or tokens that render empty), the message is `boboddy: step <stepExecutionId>`.
- The same message is used for the superproject commit and for each submodule commit.

**Push failure.** By default a failed push of the work branch, or of a submodule's copy of it, fails the step with a message naming the branch and the underlying git error. See [Work branches](/boboddy/guides/workers/#work-branches) for the behavior change this made and the consequences.

#### `readOnly` is a policy, not a sandbox

`Repo.readOnly()` tells the worker not to publish anything. It does not mount the repository read-only and does not revert edits, so an agent can still write files in its workspace. Those edits live and die with the workspace, which is deleted after the step. The guarantee you can rely on is the observable one: no branch appears on your remote and no `workBranch` is reported for the step.

A read-only step checks out the same base branch a `readWrite` step would be created off. Because it produces no work branch, later steps skip it: they are created off the nearest earlier step that did produce one. See [Base branch](/boboddy/guides/workers/#base-branch).

### Environment variables

`vars` declares the environment variables a step needs. It is a function of `{ input }` that runs once at definition time against the same input proxy `agentPrompt` uses.

```typescript
import { defineStep, Env } from "@boboddy/sdk";
import { z } from "zod";

export const accountInvestigation = defineStep({
  key: "account-investigation",
  name: "Account Investigation",
  additionalInput: z.object({ accountId: z.string(), tenant: z.string() }),
  environment: {
    vars: ({ input }) => ({
      WAREHOUSE_URL: "https://warehouse.internal",
      ACCOUNT_ID: input.accountId,
      TENANT_API_KEY: Env.value({ value: `${input.tenant}-key`, secret: true }),
      WAREHOUSE_TOKEN: Env.inherit({ secret: true }),
      DB_PASSWORD: Env.inherit({ from: "STAGING_DB_PASSWORD", secret: true }),
      LOG_LEVEL: Env.inherit({ optional: true, default: "info" }),
    }),
  },
  agentPrompt: ({ env }) =>
    `Query ${env.WAREHOUSE_URL} for account ${env.ACCOUNT_ID}.`,
});
```

#### The three forms

| Form                                                   | Source                                                                                      | Stored in the definition | Masked in logs |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------ | -------------- |
| A bare string                                          | The literal, which may interpolate `input`                                                  | The template, plaintext  | No             |
| `Env.value({ value, secret? })`                        | Same, with an explicit secret flag                                                          | The template, plaintext  | When `secret`  |
| `Env.inherit({ from?, secret?, optional?, default? })` | The **worker**. The name defaults to the key; `from` reads a differently named variable     | The name only            | When `secret`  |

`Env.inherit` fails the step before it starts if the variable is missing from the worker, unless it is `optional` (the variable is omitted) or has a `default`. A variable set to an empty string counts as set.

:::note
`Env.inherit` reads from the **worker** — `.boboddy/.env` first, then the worker's `process.env` — not from the devcontainer's `containerEnv`. A variable that exists only in `containerEnv` is not visible to it.
:::

#### Precedence

When the same name could come from more than one place, the first match wins:

1. The step's own `value` (a bare string or `Env.value`).
2. The worker's `.boboddy/.env` (`inherit`).
3. The worker's `process.env` (`inherit`).
4. The `inherit` `default`.

The step wins over the devcontainer's `containerEnv` as well. A single entry is either a `value` or an `inherit`, so in practice 2–4 apply to `inherit` entries and 1 to everything else.

#### Per-runtime behaviour

Resolution happens once, in the worker, before anything launches. Only injection differs by [runtime](#runtime):

|             | `Runtime.devcontainer()` (container)                                            | `Runtime.host()` (host process)                                                               |
| ----------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `value`     | Passed to the OpenCode process with `docker exec -e`                            | Merged into the OpenCode process's environment                                                |
| `inherit`   | The only way a worker value reaches the container                               | The host process already inherits the worker's `process.env`; `inherit` adds `.boboddy/.env`, preflight, renaming, and masking |
| `secret`    | Masked in logs                                                                  | Masked in logs                                                                                |
| Code steps  | `docker exec -e` on the runner; the function reads `process.env`                | Passed to the runner process's environment; the function reads `process.env`                   |

Step `vars` also feed MCP `{env:VAR}` substitution (see [Secrets](#secrets)), because OpenCode reads it from its own process environment — this works for the generated `OPENCODE_CONFIG_CONTENT` as well as for config files (verified on OpenCode 1.18.11).

#### Rules and limits

- Keys must match `/^[A-Z_][A-Z0-9_]*$/`. At most 64 variables per step; each value at most 4096 characters.
- Reserved names are rejected (at push validation and by the server): `BOBODDY_*`, `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `OPENCODE_CONFIG_CONTENT`, and `npm_config_cache`.
- `Env.inherit` cannot read worker variables whose name starts with `BOBODDY_` (case-insensitive) — they carry the worker's own credentials. This is rejected by definition validation when you push, by the server with a `422`, and again by the worker.
- A `secret` `value` must contain an `{{input.…}}` token; a static secret would be stored in plaintext. Use `Env.inherit({ secret: true })` instead.
- A `secret` `inherit` cannot carry a `default`, for the same reason.
- A bare static string on a key that looks like a credential (`/SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE/i`) is rejected at definition time. If the value is not actually secret, opt out with `Env.value({ value, unsafeAllowStatic: true })`; the flag is never serialized.

#### Caveats

- **`value` is stored in plaintext**, in the step definition, and is visible in the API and the UI. Anything secret belongs in `Env.inherit`.
- **Inputs are stored in the database.** A secret `value` that interpolates `{{input.…}}` is only as private as that input is.
- **Masking applies to logs only.** Registered secrets are redacted from the shipped log feed; they are not hidden from the agent or from your code. Values shorter than 4 characters (`MIN_MASKABLE_LENGTH`) are never masked.
- **A secret is not isolated from the agent.** The agent process has the variable in its environment and can read or print it.
- **Failure messages are not log-masked.** The code-step runner redacts step env values from its exec error message, but if starting OpenCode in a container fails, the error can include the `-e KEY=VALUE` arguments. This is a known limitation, tracked as a follow-up. A code step's own stdout/stderr is likewise included, unmasked, in its failure message, so avoid printing secrets.
- **Prompts see declared, non-secret keys only.** `env.X` for a secret is a type error, and a raw `{{env.X}}` token for it renders empty. Optional entries without a `default` are typed `string | undefined`.

#### Pulling steps

`boboddy pipelines pull` writes a step's `environment` back into `steps.ts`, before `agentPrompt`. A host step is written as `runtime: Runtime.host()`, a step with a selected config as `runtime: Runtime.devcontainer({ config })`, and a step on the default devcontainer omits `runtime`. `vars` is written inside `environment`, and so is `repo`, but only when it differs from the runtime's default: `Repo.readOnly()` for a read-only step, and `Repo.readWrite(...)` for a read-write step with a custom `message` or `onPushFailure: "warn"` (the function form when the message uses `input` or `result` tokens). `Runtime`, `Env` and `Repo` are imported only when needed. A static, non-secret value on a credential-looking name round-trips as `Env.value({ value, unsafeAllowStatic: true })`.

See [Running Workers](/boboddy/guides/workers/#step-environment-variables) for how the worker resolves and injects these, and [`Runtime`](/boboddy/reference/sdk/#runtime), [`Env`](/boboddy/reference/sdk/#env) and [`Repo`](/boboddy/reference/sdk/#repo) in the SDK reference.

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

### Secrets

Never put a secret value directly in a step definition — it's pushed to the
server and rendered in the UI. Reference it as `{env:VAR}` in `environment` or
`headers` instead, as shown above. `{env:VAR}` is resolved by OpenCode at
execution time from the environment of the OpenCode process, which depends on
the [runtime](#runtime):

- **`Runtime.devcontainer()`**: your project's `.boboddy/.env` is merged into the container's
  environment, so `{env:VAR}` finds those values. Variables you set yourself in
  `devcontainer.json` `containerEnv` win over `.boboddy/.env`.
- **`Runtime.host()`**: OpenCode runs on the worker host with the worker's
  `process.env`. `.boboddy/.env` is **not** part of it.

With either runtime, a variable the step declares in
[`environment.vars`](#environment-variables) is also visible to `{env:VAR}` — for example
`environment: { vars: () => ({ DATABASE_URI: Env.inherit({ secret: true }) }) }` makes `.boboddy/.env`'s
`DATABASE_URI` available to the MCP server with both runtimes, masks it in logs, and
fails the step up front if it is missing.

`.boboddy/.env` is a plain dotenv file at your repository root that you create
and manage yourself; Boboddy never writes it and never uploads it. Commit
`.boboddy/.env.example` (variable names only, no values) so teammates know what
to set, and make sure `.boboddy/.env` itself stays out of version control.

If a `pipeline-designer` session (see the [Quickstart](/boboddy/getting-started/quickstart/))
adds an MCP server that needs a secret, it writes the variable name to
`.boboddy/.env.example` for you and tells you which ones to fill in — it never
asks for or writes the real value.

### Tools already available to every step

If your project already has a `.opencode/opencode.json` (or `.jsonc`) or
`.opencode/tools/` at the repository root, whatever it declares loads for
every devcontainer step automatically — you don't need to repeat it in
`mcpServers`. Reserve a step's own `mcpServers` for servers that step needs
and the project doesn't already provide.

## Health checks

Steps can declare `healthChecks` — real tool calls Boboddy forces against the launched environment (MCP servers, plugin tools, standalone tools) **before the agent is prompted**. A broken tool fails the step immediately instead of quietly wasting an agent turn discovering it.

```typescript
export const browserStep = defineStep({
  key: "browser-repro",
  name: "Browser Repro",
  mcpServers: {
    playwright: {
      type: "local",
      command: ["npx", "-y", "@playwright/mcp"],
      enabled: true,
    },
  },
  healthChecks: [
    { mcp: "playwright", tool: "browser_navigate", args: { url: "about:blank" } },
  ],
  agentPrompt: "Reproduce the reported bug.",
});
```

`tool` is a bare tool name when `mcp` names one of the step's own `mcpServers` keys (resolved to `${mcp}_${tool}` at runtime, matching OpenCode's MCP tool-naming convention); otherwise it's a flat plugin/standalone/built-in tool id.

| Field         | Type                      | Required | Description                                                                          |
| ------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `tool`        | `string`                  | Yes      | Tool name to call. Bare name when `mcp` is set, otherwise a flat tool id              |
| `mcp`         | `string`                  | No       | One of the step's declared `mcpServers` keys                                          |
| `name`        | `string`                  | No       | Human-readable label shown in logs/UI. Defaults to the resolved tool id               |
| `args`        | `Record<string, unknown>` | No       | Arguments passed to the tool call                                                     |
| `severity`    | `"required" \| "warn"`    | No       | `"required"` (default) fails the step immediately if the check fails; `"warn"` is advisory — reported but never fails the step |
| `timeoutMs`   | `number`                  | No       | How long to wait for the forced call before failing it as a timeout. Defaults to `15000` |
| `serialGroup` | `string`                  | No       | Checks sharing the same value run one at a time, in declaration order. See [Running checks in parallel](#running-checks-in-parallel) |

### Running checks in parallel

By default, every declared check runs in its own parallel lane — a step with several health checks isn't slowed down by running them one after another. `required` checks all run before any `warn` check, and the first `required` failure stops every check that hasn't started yet (a check already in flight still finishes and reports its real outcome).

Give two or more checks the same `serialGroup` value to force them to run one at a time, in declaration order, when they contend over the same underlying resource — e.g. two checks against the same database connection:

```typescript
healthChecks: [
  { mcp: "postgres", tool: "list_schemas", serialGroup: "db" },
  { mcp: "postgres", tool: "list_tables", serialGroup: "db" },
  { mcp: "playwright", tool: "browser_navigate", args: { url: "about:blank" } },
],
```

The two `postgres` checks run serially against each other, while the `playwright` check — no `serialGroup` — runs concurrently with them.

:::caution
No secrets in `args`. Health check arguments are persisted in the database, returned by the API, and rendered in the UI, with no interpolation mechanism. Put a secret in the MCP server's `environment`/`headers` instead, referenced as `{env:VAR}` — see [Secrets](#secrets).
:::

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

A real specialization of `Features.notifications()`, not an alias — it narrows every emitted item to `kind: "feedback_request"` (in both the pushed JSON Schema and the prompt section), backed by the same `$boboddy_notifications_v1` signal. Use it when a step's primary escalation path is asking the project team clarifying questions.

### Building notifications at runtime — `Notify`

`Features.notifications()` wires the schema/signal for you, but composing a well-formed `NotificationItem` by hand still requires knowing the exact field names and the `$boboddy_notifications_v1` key. `Notify` is a separate, flat namespace of builder functions (the same shape as `Rule`/`Computed` in `@boboddy/sdk/definitions/pipelines`) for constructing a notification result value directly — most useful in a [code step](#code-steps), where there's no agent to follow the prompt instructions. It's deliberately separate from `Features`: `Features.*` is only ever something you attach via `features: [...]`; `Notify.*` is only ever something you call to build a value.

```typescript
Notify.inApp(title, body, priority, options?);
```

Returns `{ $boboddy_notifications_v1: [item] }` — return it directly if the notification is the step's whole result, or spread it into a larger result object. `options` accepts `kind` (defaults to `"status_update"`) and `payload`.

`inApp` is the only channel with dedicated sugar, because it's the only channel the platform actually delivers today — `work_item_platform_comment`, `email`, and `slack` suggestions are accepted by the schema but currently have no delivery adapter, so they'll always end up as a failed delivery rather than a silent no-op. To suggest one of those anyway (e.g. once its adapter ships), use `Notify.create({ ..., suggestedChannels: [...] })` directly — `suggestedChannels` is always just a suggestion the platform's notification policy decides on, never a delivery guarantee, which is why it isn't hidden behind a same-looking function per channel.

`Notify.feedbackRequest(question, category, urgency, suggestedKey?)` is the value-builder counterpart to `Features.feedbackRequests()`. `Notify.merge(...)` combines fragments from more than one `Notify.*` call into a single result.

```typescript
import { codeStep, Features, Notify } from "@boboddy/sdk/definitions/steps";

export const notifyBlocked = codeStep({
  key: "notify-blocked",
  name: "Notify Blocked",
  features: [Features.notifications()],
  fn: () =>
    Notify.inApp(
      "Build failed",
      "The build failed after 3 retries — needs a human look.",
      "high",
    ),
});
```

### Reading notifications back out — `NotificationSignal`

`NotificationSignal.key` is the raw `$boboddy_notifications_v1` signal key, and `NotificationSignal.find(signals)` parses a step execution's signals array back into `NotificationItem[]` (or `undefined` if none were emitted or the value doesn't parse).

## Versioning

Increment `version` when you make a breaking change to a step's schema or prompt. Old executions referencing version 1 continue using the v1 definition; new executions pick up v2.

```typescript
export const reviewStep = defineStep({
  key: "code-review",
  version: 2,
  // ...
});
```

## Code steps

`codeStep()` defines a step whose implementation is a plain function instead of an LLM prompt. It plugs into a pipeline state's `step` field exactly like `defineStep()`'s output — use it for deterministic work (aggregation, formatting, calling an internal API) that doesn't need an agent.

```typescript
import { codeStep } from "@boboddy/sdk/definitions/steps";
import { z } from "zod";

export const sumScores = codeStep({
  key: "sum-scores",
  name: "Sum Scores",
  inputSchema: z.object({ scores: z.array(z.number()) }),
  resultSchema: z.object({ total: z.number() }),
  fn: ({ scores }) => ({ total: scores.reduce((a, b) => a + b, 0) }),
  signals: [{ sourcePath: "total", key: "total", type: "number" }],
  status: "active",
});
```

`fn` must be a plain named export of the same module `codeStep()` is called from — Boboddy resolves it to a portable `{sourceFile, exportName}` reference at push time, with `sourceFile` recorded relative to the repo root (e.g. `.boboddy/pipeline-builder/sum-scores.ts`). At run time the worker imports `sourceFile` from the checked-out repo, so it must exist and be committed on whatever branch the pipeline execution runs against. Unlike `defineStep`'s `signals`, `codeStep`'s `type` is required on every signal rather than inferred from `resultSchema`. See [`codeStep(options)`](/boboddy/reference/sdk/#codestepoptions) for the full option table.

`codeStep()` also accepts [`features`](#features) — only each feature's result-schema extension and signals apply (there's no prompt to append to on a code step). See [Building notifications at runtime — `Notify`](#building-notifications-at-runtime--notify) for the `Features.notifications()` + `Notify` + code-step pairing.

`codeStep()` also accepts [`environment`](#environment), with the same `vars` forms and rules as `defineStep()` and a `runtime` limited to `Runtime.devcontainer()` (see [Runtime for code steps](#runtime-for-code-steps)). It takes `repo` with the same rules too (see [Repo access](#repo-access)): a code step that edits files is committed and pushed like an agent step, unless it uses `Repo.readOnly()`. There is no typed env argument to `fn`: the function reads the resolved variables from `process.env`.

## Pushing steps

Steps are pushed together with pipeline definitions using a single command from `.boboddy/pipeline-builder/`:

```bash
boboddy pipelines push
```

This pushes all steps exported from `steps.ts` (and any steps embedded in pipeline files) before pushing the pipeline definitions. The `key` + `version` pair uniquely identifies each step definition on the server.
