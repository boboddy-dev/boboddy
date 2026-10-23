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
| `mcps`            | `Record<string, McpHandle>`       | No       | The MCP servers the step runs with, each built with `defineMcp` together with its env vars and health checks. See [MCP servers](#mcp-servers) |
| `healthChecks`    | `StepHealthCheck[]`               | No       | `cli` checks and non-MCP `tool` checks forced against the environment before the agent is prompted. See [Health checks](#health-checks) |
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

Boboddy currently provides `boboddy.artifactsDir`, which points to the directory whose contents will be uploaded as step artifacts after the run. For a file you want to show in a comment, prefer the `boboddy-submit-artifact` tool (see [Attaching artifacts to comments](#attaching-artifacts-to-comments)).

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

### Repo config first, step overrides second

A step runs with your repository's own config by default: `.devcontainer/` for the container, `.opencode/` for OpenCode config, plugins, tools and MCP servers, and `.boboddy/` for local settings. Put anything every step needs there, so it lives in one place and works the same outside Boboddy.

Put config in the step only when it is about that step: a different devcontainer config, the variables this step needs, its repo access, the MCP servers it mounts, and its health checks. Boboddy stores only these overrides; a step that sets none runs with the repo config as is.

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

`Runtime.host()` steps are faster and cheaper because they skip the clone and container startup, and they run even for projects without a dev container. Everything else works the same: bound input, `agentPrompt`, `result`, `signals`, and `mcps` all behave identically, except that a host step can't use a [`ref`](#referencing-a-server-from-your-repository) MCP server: give it [`local`](#local-servers) or [`remote`](#remote-servers) servers instead. Because there is no checkout, the agent has no access to your repository files; if a step needs to read or change your code, keep the default `Runtime.devcontainer()`. `Runtime.host()` takes no options, so a host step cannot name a devcontainer config.

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

The worker patches the config it launches (to add mounts, ports, and `containerEnv`). That patched file is **not** committed to the step's work branch, wherever it lives. See [Set up a dev container](/boboddy/how-to/devcontainer/#multiple-configs) for writing an alternate config.

#### Runtime for code steps

[`codeStep()`](#code-steps) takes the same `environment`, with one restriction: **`Runtime.host()` is not supported**. A code step runs code from your repository, and the host runtime has no clone, so the entrypoint could never be found. This is a type error on `codeStep`, and `boboddy pipelines push` validation rejects a hand-built spec that does it.

A code step runs in a **managed runtime** by default: a small container the worker supplies, so the step does not boot your project's devcontainer to run a plain function. The worker owns the image, the generated config and the dependency install; your repository holds nothing for it. Pick one with `Runtime.managed.<id>()`, or opt out with `Runtime.devcontainer()` to run in your project's devcontainer (or the config it selects) instead.

```typescript
import { codeStep, Runtime } from "@boboddy/sdk/definitions/steps";

export const lookupCriteria = codeStep({
  key: "lookup-criteria",
  name: "Lookup Criteria",
  environment: { runtime: Runtime.managed.node24() },
  fn: lookupCriteriaFn,
});

export const needsProjectToolchain = codeStep({
  key: "needs-project-toolchain",
  name: "Needs Project Toolchain",
  environment: { runtime: Runtime.devcontainer() },
  fn: needsProjectToolchainFn,
});
```

| Identifier | Image                   | Runtime      | Install, run in `.boboddy/pipeline-builder`                                                                                                            |
| ---------- | ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun1`     | `oven/bun:1.4.0-debian` | Bun 1.x      | `bun install --production`, whichever lockfile is present or none                                                                                      |
| `node24`   | `node:24-bookworm-slim` | Node 24      | `npm install --omit=dev --no-audit --no-fund` for `package-lock.json`, `yarn.lock` or no lockfile; `corepack pnpm install --prod` for `pnpm-lock.yaml`; `bun.lock` or `bun.lockb` is not read by npm, so it installs without it and logs a notice |

`bun1` is the default: omit `runtime` and you get `Runtime.managed.bun1()`. An identifier is the runtime plus its major line. Within a line the worker floats minor and patch versions, so a worker upgrade can move the image under your step. A new major is a new identifier.

How the install works:

- Each image contains one runtime: `bun1` has Bun and no Node, `node24` has Node and no Bun. The worker runs the step with the runtime the identifier names.
- The install runs on every execution, before your function. A failing install fails the step.
- When several lockfiles are present, the first of `bun.lock`, `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json` decides.
- With no lockfile the install is a plain install, never a frozen one. The pipeline-builder scaffold gitignores lockfiles, so a fresh clone usually has none.
- A lockfile the install generates, where your repository had none, is deleted afterwards.
- A `Repo.readWrite()` step never commits the install's output (`node_modules`, `bun.lock` and `package-lock.json` under `.boboddy/pipeline-builder`), even in a repository that does not gitignore them.

Runtime-specific behavior to know about:

- **`bun1` skips dependency `postinstall` scripts** unless the package is listed in `trustedDependencies` in `.boboddy/pipeline-builder/package.json`. `node24` runs them. A dependency that needs a native build or a binary download can install cleanly on `bun1` and then fail when it is imported or run.
- **`node24` does not resolve extensionless relative imports.** `import { x } from "./helpers"` fails with `ERR_MODULE_NOT_FOUND`; write `./helpers.ts`, or use `bun1`.
- **A code step's working directory is the workspace** (the repository root in the container), not the image's default directory. This applies to every code step, including ones on `Runtime.devcontainer()`.

:::note[Behavior change for existing `Runtime.devcontainer()` code steps]
Before managed runtimes, a code step's working directory was whatever the container image set (for example `/home/bun/app` or `/`), so relative paths in `fn` behaved differently per image. It is now always the workspace. A step that relied on the old directory needs updating.
:::

:::note[Existing steps are unchanged until re-pushed]
The default applies when a step is pushed. A code step already pushed keeps running in your project's devcontainer until you push it again with `boboddy pipelines push`. To keep one on the devcontainer after a re-push, set `runtime: Runtime.devcontainer()` explicitly.
:::

Managed runtimes are for code steps only. `defineStep()` rejects them (a type error, and push validation) because an agent step needs your project's toolchain. A managed step has no `config`, and `repo` follows the usual rules: `Repo.readWrite()` (the default) or `Repo.readOnly()`.

With `Runtime.devcontainer()` the runner script executes in your container. A container selected with a non-default `config` must provide a JavaScript runtime for it: the runner uses `bun` if it is on `PATH`, otherwise `node`. That is up to the author of the config.

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
| `Runtime.managed.<id>()` | Yes                    | Yes                    | No: the worker writes its config into the clone | `readWrite` |
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
| `message`       | `string`              | `boboddy: task <taskId>`         | The commit message, rendered from the step's input and result                                    |
| `onPushFailure` | `"fail" \| "warn"`    | `"fail"`                         | Whether a failed push fails the step (`"fail"`) or is logged and ignored (`"warn"`)              |

**Commit message.** `repo` is a function of `{ input, result }`, the same way `vars` is a function of `{ input }`: both are typed from the step's `additionalInput` and `result`, and a template literal built from them (`` `fix: ${result.summary}` ``) becomes a `{{result.summary}}` token that the worker renders when the step finishes. Write the string with a prefix before the interpolation, since a bare `` `${result.summary}` `` trips a lint rule. A static `Repo.readWrite({ message: "fix: {{result.summary}}" })` is the same thing, and the common case when the message needs no tokens.

- Only `{{input.…}}` and `{{result.…}}` tokens are allowed. `{{env.…}}` is rejected, so an environment value can never reach git history.
- The template is one line and at most 500 characters.
- The rendered text carries agent output, so the worker reduces it to a safe subject: whitespace runs collapse to one space, control characters are stripped, and the subject is cut to 200 characters. If nothing is left (an empty template, or tokens that render empty), the message is `boboddy: task <taskId>`.
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
| `Env.value({ value, secret?, applies? })`                        | Same, with an explicit secret flag                                                          | The template, plaintext  | When `secret`  |
| `Env.inherit({ from?, secret?, optional?, default?, applies? })` | The **worker**. The name defaults to the key; `from` reads a differently named variable     | The name only            | When `secret`  |

`applies` says which process gets the variable; see [Setup variables](#setup-variables). A bare string always applies to the agent.

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

Step `vars` also feed MCP `{env:VAR}` substitution (see [Secrets](#secrets)), because OpenCode reads it from its own process environment — this works for the generated `OPENCODE_CONFIG_CONTENT` as well as for config files (verified on OpenCode 2.0.28).

#### Setup variables

By default a variable reaches the agent (or a code step's function) only. `applies` changes that:

| `applies`         | Reaches                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `"agent"` (default) | The agent or code step process, with `docker exec -e`                                         |
| `"setup"`         | Only the `devcontainer up` process, so your devcontainer's `initializeCommand` sees it          |
| `"both"`          | Both                                                                                            |

A setup variable overrides the worker's own variable of the same name for `devcontainer up`. Boboddy does not add it to the container's `containerEnv`; if the container needs it too, forward it from `devcontainer.json` with `${localEnv:NAME:default}`.

For example, a repo whose `initializeCommand` clones sub-repositories can let a step that never touches them skip that work:

```typescript
environment: {
  vars: () => ({
    INIT_SUBREPOS: Env.value({ value: "false", applies: "setup" }),
  }),
},
```

```jsonc title=".devcontainer/devcontainer.json"
{
  "initializeCommand": "./scripts/init-subrepos.sh",
  "containerEnv": { "INIT_SUBREPOS": "${localEnv:INIT_SUBREPOS:true}" }
}
```

Here `init-subrepos.sh` reads `INIT_SUBREPOS` on the host, and the `containerEnv` line passes the same value into the container, with `true` when no step sets it.

- `setup` and `both` need a container to set up, so they are rejected on `Runtime.host()`.
- A variable that belongs to an MCP server (see [Missing environment variables](#missing-environment-variables)) is always `agent`: MCP servers run inside the agent.
- Secrets are allowed; a secret setup value is masked in the devcontainer logs.
- A `setup`-only variable is not given to the agent, so `env.NAME` for it renders empty in the prompt.

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
- **Failure messages are not log-masked.** The code-step runner redacts step env values from its exec error message, but for an AI step, if starting OpenCode in a container fails, the error can include the `-e KEY=VALUE` arguments. This is a known limitation, tracked as a follow-up. It does not apply to code steps, which never start OpenCode. A code step's own stdout/stderr is likewise included, unmasked, in its failure message, so avoid printing secrets.
- **Prompts see declared, non-secret keys only.** `env.X` for a secret is a type error, and a raw `{{env.X}}` token for it renders empty. Optional entries without a `default` are typed `string | undefined`.

#### Pulling steps

`boboddy pipelines pull` writes a step's `environment` back into `steps.ts`, before `agentPrompt`. A host step is written as `runtime: Runtime.host()`, a step with a selected config as `runtime: Runtime.devcontainer({ config })`, and a step on the default devcontainer omits `runtime`. `vars` is written inside `environment`, and so is `repo`, but only when it differs from the runtime's default: `Repo.readOnly()` for a read-only step, and `Repo.readWrite(...)` for a read-write step with a custom `message` or `onPushFailure: "warn"` (the function form when the message uses `input` or `result` tokens). `Runtime`, `Env` and `Repo` are imported only when needed. A static, non-secret value on a credential-looking name round-trips as `Env.value({ value, unsafeAllowStatic: true })`.

See [Running Workers](/boboddy/guides/workers/#step-environment-variables) for how the worker resolves and injects these, and [`Runtime`](/boboddy/reference/sdk/#runtime), [`Env`](/boboddy/reference/sdk/#env) and [`Repo`](/boboddy/reference/sdk/#repo) in the SDK reference.

## Signals

Signals are scalar values (numbers, strings, booleans) extracted from the step result. They drive pipeline advancement policies — e.g., "only advance to the next step if `clarity_score` is above 7". Declare a signal only when a rule reads it: a later step gets an earlier step's whole output through [`ctx.output(...)`](/boboddy/guides/pipelines/#ctxoutputnodekey--an-earlier-states-whole-output), not through signals.

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
| `type`       | `"number" \| "string" \| "boolean" \| "object" \| "array" \| "artifact"` | Expected type. Inferred from `result` in `defineStep`; an [artifact field](#attaching-artifacts-to-comments) infers `"artifact"` |
| `required`   | `boolean`                           | Defaults to `true`. If true, a missing value causes the execution to fail. For an `artifact` signal only a file the agent never reported counts as missing |

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

Steps can be given access to MCP (Model Context Protocol) servers, giving the agent tools like database access, browser automation, or custom APIs. Every server is declared with `defineMcp`, together with the environment variables it needs and its health checks, and mounted on a step under `mcps`. The `mcps` key is the name the step runs the server under: a server mounted as `postgres` exposes its tools as `postgres_<tool>`, and only the step's agent may call them.

`defineMcp` takes a `type`:

| `type`     | The server                                                                          |
| ---------- | ----------------------------------------------------------------------------------- |
| `"ref"`    | One your repository already defines. See [Referencing a server from your repository](#referencing-a-server-from-your-repository) |
| `"local"`  | Written in TypeScript and launched as a subprocess. See [Local servers](#local-servers) |
| `"remote"` | Written in TypeScript and reached over HTTP. See [Remote servers](#remote-servers)   |

```typescript
import { defineMcp, defineStep } from "@boboddy/sdk/definitions/steps";

const postgres = defineMcp({
  type: "ref",
  name: "postgres",
  healthChecks: {
    listSchemas: { tool: "list_schemas" },
    listTables: { tool: "list_tables", args: { schema: "public" }, enabled: false },
  },
});

export const triage = defineStep({
  key: "triage",
  name: "Triage",
  agentPrompt: "Find the rows behind this report.",
  mcps: { postgres },
});
```

### The definition

| Field          | Type                       | Required | Description |
| -------------- | -------------------------- | -------- | ----------- |
| `type`         | `"ref" \| "local" \| "remote"` | Yes  | Which kind of server, as above |
| `name`         | `string`                   | Yes      | For a `ref`, the server's name in your repository's MCP config. For `local` and `remote`, a label used in error messages; the `mcps` key names the server at runtime |
| `env`          | `string[]`                 | No       | Worker variables the server needs. Only for a server that reads `process.env` itself: every `{env:VAR}` in the server's definition is required automatically |
| `optionalEnv`  | `string[]`                 | No       | Worker variables passed to the server when they are set. A `{env:VAR}` listed here is not made required |
| `healthChecks` | `Record<string, McpCheck>` | No       | Checks keyed by name: `{ tool, args?, timeoutSeconds?, severity?, serialGroup?, enabled? }`, as in [Health checks](#health-checks) but without `mcp` or `name` |
| `timeout`      | `{ startup?, catalog?, execution? }` | No | Timeouts in milliseconds: connecting, listing tools, and each tool call |
| `codemode`     | `boolean`                  | No       | Defaults to `false` for step servers, so the agent and [health checks](#health-checks) can call each tool by name. `true` routes the tools through OpenCode's Code Mode instead |
| `protocol`     | `"legacy" \| "auto" \| "2026-07-28"` | No | MCP protocol version to negotiate |

`local` and `remote` add the fields in their sections below. `defineMcp` throws on an unknown field, so OpenCode v1 keys (`enabled`, a numeric `timeout`, camelCase `oauth` fields) are rejected. There is no `disabled`: a step that shouldn't run a server doesn't mount it.

A compiled check is named `<mcpsKey>.<checkName>` (`postgres.listSchemas`). Checks on the same server run one at a time, as if they shared `serialGroup: <mcpsKey>`; give one an explicit `serialGroup` to change that. Different servers still run in parallel. `enabled: false` defines a check that only runs on steps that call `.enableCheck()`. Variable names follow the [environment variable rules](#rules-and-limits); a `BOBODDY_*` name is rejected because the worker never passes its own credentials on.

### Referencing a server from your repository

A `ref` uses a server your repository already defines, by name, without repeating its definition. Mounting it under a different key aliases it:

```typescript
const postgres = defineMcp({ type: "ref", name: "postgres" });

defineStep({
  // ...
  mcps: { db: postgres },
});
```

The worker resolves each ref just before it launches the step, on the machine running `boboddy work`, from files in the step's checkout only. Your global OpenCode config is never used. The first file that defines the name wins:

1. `.opencode/opencode.json`
2. `.opencode/opencode.jsonc`
3. `opencode.json`
4. `opencode.jsonc`
5. `.mcp.json` (Claude Code)
6. `.cursor/mcp.json`
7. `.vscode/mcp.json`
8. `.codex/config.toml`

Each definition is converted to OpenCode's shape. OpenCode configs may use the v2 `mcp.servers.<name>` shape or the v1 `mcp.<name>` shape. `${VAR}` and `${env:VAR}` become `{env:VAR}`, and every such variable is required on the worker (see [Secrets](#secrets)). A relative `cwd` is resolved against the agent's workspace. `timeout`, `codemode` and `protocol` on the `defineMcp` are applied on top of the resolved definition. These definitions can't be used:

- a `.vscode/mcp.json` server that reads an `${input:…}` prompt
- a server using an editor variable such as `${workspaceFolder}`
- a server with a literal credential in its command or URL

A literal credential in `env` or `headers` is dropped from the definition.

A `Runtime.host()` step has no checkout, so it can't use a ref. Give it a [local](#local-servers) or [remote](#remote-servers) server instead.

Push does not check that a ref exists, because the server can't see your machine. A ref that matches nothing fails the step before launch with an error that lists every file searched.

### Local servers

A server your repository doesn't define can be written inline. A `local` server is launched as a subprocess:

```typescript
const postgres = defineMcp({
  type: "local",
  name: "postgres",
  command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
  environment: { DATABASE_URI: "{env:DATABASE_URI}" },
  healthChecks: { listSchemas: { tool: "list_schemas" } },
});
```

| Field         | Type                     | Required | Description                                                        |
| ------------- | ------------------------ | -------- | ------------------------------------------------------------------ |
| `command`     | `string[]`               | Yes      | Executable plus arguments; must have at least one entry. There is no separate `args` field |
| `cwd`         | `string`                 | No       | Working directory for the subprocess                               |
| `environment` | `Record<string, string>` | No       | Environment variables. Every value must be written as `{env:VAR}` |

The command must be resolvable where the step runs: inside the devcontainer for a `Runtime.devcontainer()` step, on the worker host for a `Runtime.host()` step.

### Remote servers

A `remote` server is reached over HTTP:

```typescript
const linear = defineMcp({
  type: "remote",
  name: "linear",
  url: "https://mcp.linear.app/mcp",
  headers: { Authorization: "Bearer {env:LINEAR_API_KEY}" },
});
```

| Field     | Type                     | Required | Description                                              |
| --------- | ------------------------ | -------- | -------------------------------------------------------- |
| `url`     | `string`                 | Yes      | Server URL                                               |
| `headers` | `Record<string, string>` | No       | Extra request headers. Every value must be written as `{env:VAR}`, optionally after an auth scheme (`Bearer {env:TOKEN}`) |
| `oauth`   | `object \| false`        | No       | OAuth config (`client_id`, `client_secret`, `scope`, `callback_port`, `redirect_uri`, `auth_server_metadata_url`), or `false` to disable |

### Variables in inline servers

`defineMcp` rejects a literal `environment` or `headers` value, because it would be pushed to the server and shown in the UI. Write each one as `{env:VAR}`.

Every `{env:VAR}` in a `local` server's `command`, `cwd` or `environment`, or a `remote` server's `url` or `headers`, becomes a **required** worker variable for that server, the same way the worker infers them for a ref. The worker reads it from `.boboddy/.env`, then its own `process.env`, before launch. If it's missing, the step fails before launch, even on a `Runtime.devcontainer()` step whose container would have set it (for example in `containerEnv`). When the server can run without the variable, list it in `optionalEnv`, so the server launches without it (see [Missing environment variables](#missing-environment-variables)).

### Reusing an MCP server across steps

Define each server once and mount it on every step that uses it. Each step adjusts it with builder methods, so the checks and variables can't drift between copies.

```typescript
export const explain = defineStep({
  key: "explain",
  name: "Explain",
  agentPrompt: "Explain the data problem.",
  mcps: {
    db: postgres
      .enableCheck("listTables")
      .overrideCheck("listSchemas", { timeoutSeconds: 30, severity: "warn" }),
  },
});
```

#### The builder

Every method returns a new handle and leaves the one it was called on unchanged, so any number of steps can chain off one definition.

| Method                        | Effect |
| ----------------------------- | ------ |
| `.overrideCheck(name, patch)` | Changes `tool`, `args`, `timeoutSeconds`, `severity` or `serialGroup`. `args` is replaced whole, not merged; later patches of the same field win |
| `.disableCheck(name)`         | Turns a check off. A disabled check stays off whatever `overrideCheck` does, in either order |
| `.enableCheck(name)`          | Turns a check on. Between `enableCheck` and `disableCheck`, the last call wins |
| `.addCheck(name, check)`      | Adds a check for this step. The name must be new |
| `.disableAllChecks()`         | Turns off every check defined so far; a later `enableCheck` or `addCheck` turns one back on |

`name` is typed from the definition's check names (plus any added earlier in the chain), so a typo is a type error; an unknown name also throws at runtime.

#### Severity

Severity belongs to each check, not to the server. A check is `required` unless it sets `severity: "warn"`, either in `defineMcp`'s `healthChecks` or for one step with `.overrideCheck(name, { severity: "warn" })`:

```typescript
const datadog = defineMcp({
  type: "ref",
  name: "datadog",
  env: ["DATADOG_API_KEY", "DATADOG_APP_KEY"],
  healthChecks: { monitors: { tool: "get_monitors", severity: "warn" } },
});

// or, on one step only:
mcps: { datadog: datadog.overrideCheck("monitors", { severity: "warn" }) }
```

A failed `warn` check is reported, and the step still runs with the server.

#### Missing environment variables

The worker checks a server's variables before it launches the step. A variable in `env`, or read by a `{env:VAR}` in the server's definition, is required: if it's missing, the step fails before launch, naming the variable and the server: `DATABASE_URI (for MCP "postgres")`. A variable listed in `optionalEnv` is passed when set and otherwise left out, without an error. A check's severity doesn't change this.

A step's own [`environment.vars`](#environment-variables) entry with the same name wins over the server's, so a step can supply the value from its input. Two servers that need the same variable share one entry.

:::note[Code steps in the same file]
A step file that also exports a [`codeStep`](#code-steps) must keep its `defineMcp`s in that file. The code-step container can't resolve an extensionless relative import such as `./mcps`, so share definitions across files only between files with no code steps.
:::

### Servers a step doesn't list are turned off

A step runs with only the servers in its `mcps`. Every other server defined in the files above is passed to OpenCode with `disabled: true`, including servers in `.opencode/opencode.json` that OpenCode would otherwise load on its own. With an alias (`mcps: { db: postgres }`), the server runs as `db` only.

### Secrets

Never put a secret value directly in a step definition — it's pushed to the
server and rendered in the UI. Reference it as `{env:VAR}` in an inline
server's `environment` or `headers` instead, as shown above; `defineMcp`
rejects a literal value there.

A `defineMcp` server's variables (its `env`, its `optionalEnv`, and every
`{env:VAR}` in its definition, inline or in your repository) are read from the
**worker** — `.boboddy/.env` first, then the worker's `process.env` — and
passed to the server with either [runtime](#runtime). They are always treated
as secrets: masked in logs and never added to the prompt's `env`. A required
one that is missing fails the step before launch; see
[Variables in inline servers](#variables-in-inline-servers).

A variable the step declares in [`environment.vars`](#environment-variables)
is also visible to the server, and wins over the server's own entry — for
example `environment: { vars: () => ({ DATABASE_URI: Env.inherit({ from: "REPLICA_URI", secret: true }) }) }`
renames a worker variable for the server.

`.boboddy/.env` is a plain dotenv file at your repository root that you create
and manage yourself; Boboddy never writes it and never uploads it. Commit
`.boboddy/.env.example` (variable names only, no values) so teammates know what
to set, and make sure `.boboddy/.env` itself stays out of version control.

If a `pipeline-designer` session (see the [Quickstart](/boboddy/getting-started/quickstart/))
adds an MCP server that needs a secret, it writes the variable name to
`.boboddy/.env.example` for you and tells you which ones to fill in — it never
asks for or writes the real value.

### Tools already available to every step

Custom tools in `.opencode/tools/` at the repository root load for every
devcontainer step automatically. MCP servers don't: a step gets only the
servers it lists, so a server your repository already defines is pulled in
with a [`ref`](#referencing-a-server-from-your-repository), not repeated.

## Health checks

Health checks are real calls Boboddy forces against the launched environment **before the agent is prompted**. A broken tool fails the step immediately instead of quietly wasting an agent turn discovering it.

A check on an MCP tool is declared on its server, in the `defineMcp`'s `healthChecks` (see [The definition](#the-definition)); every step that mounts the server gets it. A step's own `healthChecks` holds everything else: `cli` checks, which run a command, and `tool` checks on plugin, standalone and built-in tools. It runs after the server checks.

```typescript
const playwright = defineMcp({
  type: "local",
  name: "playwright",
  command: ["npx", "-y", "@playwright/mcp@0.0.68", "--headless"],
  healthChecks: {
    navigate: { tool: "browser_navigate", args: { url: "about:blank" } },
  },
});

export const browserStep = defineStep({
  key: "browser-repro",
  name: "Browser Repro",
  mcps: { playwright },
  healthChecks: [
    { kind: "cli", command: ["npx", "--no-install", "playwright", "--version"], severity: "warn" },
  ],
  agentPrompt: "Reproduce the reported bug.",
});
```

A `tool` check's `tool` is a flat plugin/standalone/built-in tool id. A step's `healthChecks` doesn't accept `mcp`; on a `defineMcp` check, `tool` is the bare tool name, resolved to `<mcpsKey>_<tool>` at runtime (OpenCode's MCP tool-naming convention).

| Field         | Type                      | Required | Description                                                                          |
| ------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `kind`        | `"tool" \| "cli"`         | No       | `"tool"` (default) calls a tool; `"cli"` runs a command                              |
| `tool`        | `string`                  | `tool`   | Tool id to call                                                                       |
| `args`        | `Record<string, unknown>` | No       | Arguments passed to the tool call (`tool` only)                                       |
| `command`     | `string[]`                | `cli`    | Executable plus arguments, run through OpenCode's `bash` tool in the step's environment |
| `expectExitCode` | `number`               | No       | Exit code that counts as passing (`cli` only). Defaults to `0`                        |
| `name`        | `string`                  | No       | Human-readable label shown in logs/UI. Defaults to the resolved tool id               |
| `severity`    | `"required" \| "warn"`    | No       | `"required"` (default) fails the step immediately if the check fails; `"warn"` is advisory — reported but never fails the step |
| `timeoutSeconds` | `number`               | No       | Seconds to wait for the forced call before failing it as a timeout. Fractions allowed; must be above `0` and at most `3600`. Defaults to `15` |
| `serialGroup` | `string`                  | No       | Checks sharing the same value run one at a time, in declaration order. See [Running checks in parallel](#running-checks-in-parallel) |

### Running checks in parallel

By default, every declared check runs in its own parallel lane — a step with several health checks isn't slowed down by running them one after another. `required` checks all run before any `warn` check, and the first `required` failure stops every check that hasn't started yet (a check already in flight still finishes and reports its real outcome).

Give two or more checks the same `serialGroup` value to force them to run one at a time, in declaration order, when they contend over the same underlying resource. Checks on one `defineMcp` server already share a `serialGroup` (its `mcps` key); set it explicitly to serialize across servers, or across a step's own checks:

```typescript
healthChecks: [
  { kind: "cli", command: ["npx", "--no-install", "vitest", "--version"], serialGroup: "npx" },
  { kind: "cli", command: ["npx", "--no-install", "playwright", "--version"], serialGroup: "npx" },
],
```

:::caution
No secrets in `args`. Health check arguments are persisted in the database, returned by the API, and rendered in the UI, with no interpolation mechanism. Put a secret in the MCP server's `environment`/`headers` instead, referenced as `{env:VAR}` — see [Secrets](#secrets).
:::

## Plugins

Steps don't declare OpenCode plugins. Add plugins to `.opencode/opencode.json` in your repo: the OpenCode that runs each step loads that file, so every step that runs against the repo gets them.

```json title=".opencode/opencode.json"
{
  "plugins": [
    "opencode-wakatime",
    { "package": "@my-org/opencode-plugin", "options": { "region": "us" } }
  ]
}
```

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
| `payload`           | `Record<string, unknown>`                                                   | No       | Kind-specific data. For `feedback_request`: `{ category, urgency }` |

The feature contributes a single signal, `$boboddy_notifications_v1` (type `array`, not required), so downstream advancement rules can react to emitted notifications.

### `Features.feedbackRequests()`

A real specialization of `Features.notifications()`, not an alias — it narrows every emitted item to `kind: "feedback_request"` (in both the pushed JSON Schema and the prompt section), backed by the same `$boboddy_notifications_v1` signal. Use it when a step's primary escalation path is asking the project team clarifying questions.

### Building notifications at runtime — `Notify`

`Features.notifications()` wires the schema/signal for you, but composing a well-formed `NotificationItem` by hand still requires knowing the exact field names and the `$boboddy_notifications_v1` key. `Notify` is a separate, flat namespace of builder functions (the same shape as `Rule`/`Computed` in `@boboddy/sdk/definitions/pipelines`) for constructing a notification result value directly — most useful in a [code step](#code-steps), where there's no agent to follow the prompt instructions. It's deliberately separate from `Features`: `Features.*` is only ever something you attach via `features: [...]`; `Notify.*` is only ever something you call to build a value.

```typescript
Notify.inApp(title, body, priority, options?);
```

Returns `{ $boboddy_notifications_v1: [item] }` — return it directly if the notification is the step's whole result, or spread it into a larger result object. `options` accepts `kind` (defaults to `"status_update"`) and `payload`.

`inApp` is the only channel with dedicated sugar, because it's the only channel delivered without a human in the loop. `work_item_platform_comment` is delivered too, but as a draft: a human reviews the exact text and approves it before it is posted to the work item on Jira, GitHub or Bitbucket (see [Attaching artifacts to comments](#attaching-artifacts-to-comments) for showing files in it). `email` and `slack` suggestions are accepted by the schema but have no delivery adapter yet, so they end up as a failed delivery rather than a silent no-op. To suggest any channel other than `in_app`, use `Notify.create({ ..., suggestedChannels: [...] })` directly — `suggestedChannels` is always just a suggestion the platform's notification policy decides on, never a delivery guarantee, which is why it isn't hidden behind a same-looking function per channel.

`Notify.feedbackRequest(question, category, urgency)` is the value-builder counterpart to `Features.feedbackRequests()`. `Notify.merge(...)` combines fragments from more than one `Notify.*` call into a single result.

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

`NotificationSignal.key` is the raw `$boboddy_notifications_v1` signal key, and `NotificationSignal.find(signals)` parses a task's signals array back into `NotificationItem[]` (or `undefined` if none were emitted or the value doesn't parse).

## Attaching artifacts to comments

A step can produce files, such as a screen recording or a screenshot, and a work item comment can show them. There are two kinds of artifact:

- **Declared** artifacts are fields in the step's result schema, built with `z.artifact(...)`. They have a known name, can be read as a signal, can drive routing, and can be embedded by reference.
- **Undeclared** artifacts are any other files the step leaves in `boboddy.artifactsDir`. They are uploaded too, and a comment can only point at them by file name or glob.

### Declaring an artifact field

Import `z` from the SDK rather than from `zod`. It is the whole of Zod plus `z.artifact`:

```typescript
import { ArtifactTypes, defineStep, z } from "@boboddy/sdk/definitions/steps";

export const reproduce = defineStep({
  key: "reproduce",
  name: "Reproduce",
  result: z.object({
    reproduced: z.boolean(),
    reproVideo: z
      .artifact({ accept: [...ArtifactTypes.video, ".gif"] })
      .nullable()
      .describe("Screen recording of the reported failure"),
  }),
  signals: [{ sourcePath: "reproVideo", required: false }],
  agentPrompt: `Reproduce the bug and record it. Submit the recording with
boboddy-submit-artifact using field "reproVideo".`,
});
```

`accept` lists the file extensions the field takes, lower-case with a leading dot (`".mp4"`, not `"mp4"` or `".MP4"`); a wrong entry throws when the step is defined. Leave it out to accept any file. `ArtifactTypes.video` is `.mp4 .webm .mov` and `ArtifactTypes.image` is `.png .jpg .jpeg .gif .svg`.

An artifact field can't sit inside an array. A signal whose `sourcePath` points at an artifact field gets the type `"artifact"`.

### Submitting the file from an agent step

The agent calls the `boboddy-submit-artifact` tool with `{ path, field?, name? }`. The tool copies the file into the step's artifacts:

- With `field`, the file fills that declared field and is stored as `<field><ext>`, for example `reproVideo.mp4`. Submitting again replaces the earlier file.
- With only `name`, it becomes an undeclared artifact under that name.

When the agent writes its findings, Boboddy fills in the artifact fields itself. The agent must not write artifact values into its findings. A nullable field that was never submitted is set to `null`. A non-nullable field that was never submitted is rejected, and the agent is asked to submit the file.

Files written straight into `boboddy.artifactsDir` are still uploaded, but only as undeclared artifacts.

### Returning a file from a code step

A code step's `fn` gets a second argument, `{ artifactsDir }`, the absolute path of its artifacts folder. Write the file there and return `Artifact.path(...)` with its path relative to that folder:

```typescript
import { Artifact, ArtifactTypes, codeStep, z } from "@boboddy/sdk/definitions/steps";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const renderChart = codeStep({
  key: "render-chart",
  name: "Render Chart",
  resultSchema: z.object({ chart: z.artifact({ accept: ArtifactTypes.image }) }),
  fn: async (_input, { artifactsDir }) => {
    await writeFile(join(artifactsDir, "chart.png"), await drawChart());
    return { chart: Artifact.path("chart.png") };
  },
  signals: [{ sourcePath: "chart", key: "chart", type: "artifact" }],
});
```

The worker checks every returned path: it must stay inside the folder, exist, be non-empty and have an accepted extension.

### Embedding and linking in a comment

`Artifact.embed(target, { caption })` and `Artifact.link(target, { label })` return a marker string that you put in a notification `body` or in a step prompt:

| Target                      | Marker                                            | If the file is missing         |
| --------------------------- | ------------------------------------------------- | ------------------------------ |
| `step.signals.<key>`        | `![caption](artifact:signal/<stepKey>/<signalKey>)` | Required: the comment is not drafted |
| A file name or glob string  | `[label](artifact:<glob>)`                        | Optional: the marker is removed |

```typescript
Notify.create({
  kind: "status_update",
  title: "Reproduced",
  body: `Steps to reproduce:\n\n1. ...\n\n${Artifact.embed(reproduce.signals.reproVideo, {
    caption: "Recording of the failure",
  })}`,
  priority: "normal",
  suggestedChannels: ["work_item_platform_comment"],
});
```

Rules for markers:

- Put each marker in its own paragraph. A marker inside other text gets a warning and is shown as a link.
- Don't refer to the artifact in the text around the marker ("see the video below"). The marker may be removed, and the text would then point at nothing.
- When a glob matches several files, the newest one is used.
- Embedding a step that isn't in the pipeline is an error. Embedding a field whose `accept` has no extension the platforms can embed is a warning.

Boboddy checks the markers in step prompts when you push.

### When the file is missing

When the comment is drafted, each marker is resolved. A **signal marker** whose artifact is unavailable means no draft is created for that comment (suppression reason `artifact_unavailable`). An unavailable **path marker** is removed along with its paragraph, and the rest of the comment is kept.

An artifact signal records why the file is unavailable as `unavailableReason`:

| Value                 | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `not_reported`        | The field was `null` or never filled                       |
| `wrong_extension`     | The file's extension isn't in `accept`                     |
| `upload_failed:<code>` | The file was found but failed to upload, with the error code |
| `not_found`           | No uploaded file matches the field                         |

A `required` artifact signal fails the step only on `not_reported`.

### Routing on whether the file exists

Rules see an artifact signal as either its value or `null`. Use the `exists` and `notExists` operators, which take no value:

```typescript
checkRecording: {
  kind: "choice",
  choices: [{ when: Rule.when("reproVideo", "exists"), next: "reportReproduction" }],
  default: "failingTest",
},
```

In a fan-out's `advanceEach`, `signal("reproVideo").exists()` does the same (see [Pipeline Advancement](/boboddy/guides/pipeline-advancement/)). A choice reads the signals of the step that ran just before it, so put the check straight after the step that produces the file.

:::tip
Make optional recordings `.nullable()` and route on `exists`. The comment that embeds the recording is then only drafted when there is a recording to show, and runs without one take another path instead of producing a suppressed draft.
:::

### Reviewing the draft

A comment with markers is still a draft that a human approves. Under the draft's editor, **Preview** shows each embedded file inline (a video player or an image) and each link marker as a link. A marker you add while editing shows "Not checked yet — approve to check this file".

- **Left out** lists the optional markers that were removed when the draft was created, with the reason for each, for example "no saved file matched".
- When a required file was missing, there is no draft to review. The notification shows **Comment not drafted** with the reason, such as "the upload failed (storage limit reached)", and a link to the step.

### Approval

On approval every marker is resolved again, including markers you added. If any artifact has since become unavailable (for example, it expired after 30 days or was deleted), approval fails with `artifact_unavailable`. Nothing is posted, and a banner names each unavailable marker. Remove those markers and approve again, or reject the draft.

Retrying a failed approval never uploads a file twice: Boboddy records each file it has already uploaded and reuses it.

### What each platform shows

| Platform   | Embedded                        | Otherwise                         |
| ---------- | ------------------------------- | --------------------------------- |
| Jira Cloud | `.png`, `.gif`, `.mp4`, `.webm` | Link to the file in Boboddy       |
| GitHub     | Nothing in v1                   | Link to the file in Boboddy       |
| Bitbucket  | Nothing in v1                   | Link to the file in Boboddy       |

An embed that falls back to a link keeps its caption as the line before the link, so the comment reads the same either way:

```markdown
Recording of the failure
[View reproVideo.webm in Boboddy](https://<your Boboddy URL>/projects/<projectId>/artifacts/<artifactId>)
```

- **Jira Cloud** gets each embeddable file as an attachment on the issue, shown inline in the comment. If Jira doesn't return the attachment's media ID, the comment links to the attachment instead. Any other extension is linked to Boboddy, whatever the field's `accept` allows.
- **GitHub** comments are posted with the GitHub App's installation token (or your token), and GitHub doesn't let those tokens upload files, so every file is linked. This is the same with the App and with a token.
- **Bitbucket** links every file in v1.

Links go to the file's page in Boboddy, `/projects/<projectId>/artifacts/<artifactId>`, which shows a preview and a download button. Readers need to sign in to Boboddy as a project member to open it, so people on the issue who aren't project members can't see linked files. After 30 days the page says the file has expired.

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

`fn` can be an inline function, and the step can be exported by name, embedded in a pipeline's `states`, or both. Boboddy records only the module's `sourceFile` at push time, relative to the repo root (e.g. `.boboddy/pipeline-builder/sum-scores.ts`). At run time the worker imports `sourceFile` from the checked-out repo and finds the step in it by `key`, so the file must exist and be committed on whatever branch the pipeline execution runs against. Closures and module-level helpers work because the whole module is imported.

```typescript
export default definePipeline({
  key: "scoring",
  startAt: "sum",
  states: {
    sum: {
      kind: "step",
      step: codeStep({
        key: "inline-only",
        name: "Inline only",
        resultSchema: z.object({ ok: z.boolean() }),
        fn: () => ({ ok: true }),
      }),
      next: "done",
    },
    done: { kind: "succeed" },
  },
});
```

The `key` is the step's identity, and `version` is not part of the lookup. Pushing fails if two code steps share a `key` but differ in `version`, or if two files define the same `key` with different `fn`s. If a module holds more than one distinct `fn` under one `key`, the step fails at run time.

The worker resolves the step with `@boboddy/sdk/code-step-lookup` from the SDK installed in `.boboddy/pipeline-builder/node_modules`, not the version used to push. If that SDK is too old to ship it, the step fails with `the installed @boboddy/sdk is too old for inline code steps; upgrade it`, followed by the installed version (for example `installed version: 0.6.0`). Upgrade `@boboddy/sdk` in `.boboddy/pipeline-builder` (and commit the updated `package.json` and lockfile) to fix it.

During a run the worker writes a temporary `.code-step-runner-<uuid>.mjs` next to `sourceFile` and removes it afterwards.

`fn(input, { artifactsDir })` also gets the absolute path of the step's artifacts folder. Write files there and return `Artifact.path("<relative path>")` in a `z.artifact` field to declare them (see [Returning a file from a code step](#returning-a-file-from-a-code-step)).

Unlike `defineStep`'s `signals`, `codeStep`'s `type` is required on every signal rather than inferred from `resultSchema`; an artifact field's signal uses `type: "artifact"`. See [`codeStep(options)`](/boboddy/reference/sdk/#codestepoptions) for the full option table.

`codeStep()` also accepts [`features`](#features) — only each feature's result-schema extension and signals apply (there's no prompt to append to on a code step). See [Building notifications at runtime — `Notify`](#building-notifications-at-runtime--notify) for the `Features.notifications()` + `Notify` + code-step pairing.

`codeStep()` also accepts [`environment`](#environment), with the same `vars` forms and rules as `defineStep()` and a `runtime` of `Runtime.managed.<id>()` (the default, `bun1`) or `Runtime.devcontainer()` (see [Runtime for code steps](#runtime-for-code-steps)). It takes `repo` with the same rules too (see [Repo access](#repo-access)): a code step that edits files is committed and pushed like an agent step, unless it uses `Repo.readOnly()`. There is no typed env argument to `fn`: the function reads the resolved variables from `process.env`.

A code step never starts OpenCode. The worker launches the step's container (a managed runtime, or your devcontainer), runs the entrypoint, and reads the findings file the runner wrote, so a code step needs no AI provider credentials, and Boboddy neither exports nor injects any for it. Boboddy does not inject the OpenCode runtime mount, published port or host-gateway run args into its devcontainer, and writes no `.opencode/` files into the workspace. Those injections are what reject `docker-compose`-based devcontainer configs for AI steps, so a code step is not subject to that restriction. If the runner finishes without writing its findings file, the step fails immediately.

## Pushing steps

Steps are pushed together with pipeline definitions using a single command from `.boboddy/pipeline-builder/`:

```bash
boboddy pipelines push
```

This pushes all steps exported from `steps.ts` (and any steps embedded in pipeline files) before pushing the pipeline definitions. The `key` + `version` pair uniquely identifies each step definition on the server.
