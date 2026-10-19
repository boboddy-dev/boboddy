
# Boboddy pipeline authoring reference

Everything below is verified against the shipped SDK. Prefer these shapes over
anything you infer from memory.

Code fences are tagged. A plain `ts` fence is a complete file that compiles as
written. A `ts fragment` fence is a partial illustration of one field or one
call — it will not compile on its own, so read it, do not paste it.

## 0. The directory

You are working inside `.boboddy/pipeline-builder/`. `boboddy pipelines push`
scans **this directory only** — not subdirectories.

| File                             | Role                                                                 |
| --------------------------------- | --------------------------------------------------------------------- |
| `<pipeline-key>.ts`              | One pipeline. Must `export default definePipeline({ ... })`.          |
| `steps.ts`                       | Shared steps as **named** exports. Optional; steps may live inline.   |
| `default-pipeline-assignment.ts` | Reserved. Routes incoming work items to a pipeline. Never a pipeline. |
| `push.ts`                        | Generated on every push. Never edit. Skipped by the scanner and by the typecheck. |
| `package.json`, `tsconfig.json`  | Scaffolded. `@boboddy/sdk` + `zod` are the only deps you may import.  |

Imports:

```ts
import { z } from "zod";
import {
  defineMcp,
  defineStep,
  Env,
  Features,
  Runtime,
} from "@boboddy/sdk/definitions/steps";
import {
  definePipeline,
  defaultPipelineAssignment,
  Rule,
} from "@boboddy/sdk/definitions/pipelines";
```

## 1. Steps — `defineStep`

A step is one unit of AI work: a prompt, an optional typed input, a typed
result, and the signals lifted out of that result.

```ts
import { z } from "zod";
import { defineStep, Env, Features, Runtime } from "@boboddy/sdk/definitions/steps";

export const investigate = defineStep({
  key: "investigate", // stable identity; never reuse for a different job
  name: "Investigate",
  description: "Find the root cause from logs and data.",
  status: "active",
  version: 1, // optional, defaults to 1; bump for a breaking redefinition
  environment: {
    runtime: Runtime.host(), // default: Runtime.devcontainer()
    vars: () => ({ READONLY_DB_URL: Env.inherit() }),
  },

  agentPrompt: ({ input, env }) => `
Investigate the reported problem, scoped to ${input.accountRef}.
The read-only database is at ${env.READONLY_DB_URL}.
`,

  // Optional on purpose: this field is supplied by the step's own `input`
  // mapper in the pipeline that uses it (see §3). A required field here
  // would force every pipeline using this step to supply it explicitly.
  additionalInput: z.object({
    accountRef: z.string().nullable().optional(),
  }),

  result: z.object({
    findings: z.string(),
    rootCause: z.string(),
    severity: z.enum(["low", "high", "critical"]),
  }),

  // Only `severity` is a signal: a `choice` rule routes on it. Later steps
  // read `findings` and `rootCause` through `ctx.output("investigate")`.
  signals: [{ sourcePath: "severity" }],

  features: [Features.notifications()],
});
```

### Field notes

- **`agentPrompt`** — a string, or a function `({ input, env, boboddy }) => string`.
  Interpolations compile to `{{input.x}}` / `{{env.X}}` / `{{boboddy.artifactsDir}}`
  tokens that are substituted at execution time.
  - `input.x` only type-checks when `additionalInput` declares `x`. With no
    `additionalInput`, `input` is opaque and any property access is a type error.
  - The step's full resolved input JSON is shown to the agent regardless.
    Interpolation is for emphasis and for weaving a value into a sentence.
  - `boboddy.artifactsDir` is the directory the execution collects artifacts
    from (traces, screenshots, reports). It already ends in a separator.
- **`additionalInput`** — extra fields the state that runs this step must bind
  via its own `input` mapper (see §3). `z.unknown()` means "no declared extra
  input" and keeps the mapper optional.
- **`result`** — the schema the agent's structured answer must satisfy. Later
  steps consume the **whole** result: bind it with `ctx.output(stateKey)`
  (see §3), not field by field.
- **`signals`** — a signal exists only because a rule reads it: a `choice`
  branch's `when`, a `loop`'s `until`. Do not declare a signal to pass data to
  a later step; that is what `ctx.output()` is for. A step no rule reads has no
  `signals` at all.
  `{ sourcePath, key?, type?, required?, availableWhenResultStatusIn? }`.
  `key` defaults to `sourcePath`; `type` is inferred from the result schema;
  `required` defaults to `true`. Dot paths work: `{ sourcePath: "scores.clarity", key: "clarity" }`.
  - **`sourcePath` is NOT type-checked.** A typo compiles cleanly and fails only
    at execution time, when the extractor finds nothing. Re-read every
    `sourcePath` against the `result` schema by eye before pushing.
- **`features`** — `Features.notifications()` adds the `$boboddy_notifications_v1`
  result field, the matching prompt section, and the signal. Use it instead of
  hand-writing a notification schema.
- **`environment`** — `{ runtime?, vars?, repo? }`, how the step runs. Declare `vars`
  before `agentPrompt` so its keys are typed into the prompt's `env`.
  - `runtime`: `Runtime.devcontainer()` (default) clones the repo and runs inside
    the project devcontainer. `Runtime.devcontainer({ config: ".devcontainer/alt/devcontainer.json" })`
    launches that repo-relative file instead (full path, basename
    `devcontainer.json`; there is no fallback if it is missing).
    `Runtime.host()` runs with no repo and no Docker; use it for classification,
    scoring, and any investigation that only needs MCP tools.
  - `vars`: `({ input }) => ({ NAME: value })`, the env vars injected into the
    step. A plain string is a value, `Env.inherit()` reads the worker's own
    variable of that name, and `Env.value({ value, secret: true })` marks a
    secret. Never write a secret value into a step file.
    By default a variable reaches the agent only. `applies: "setup"` on
    `Env.value` or `Env.inherit` hands it to `devcontainer up` instead, so the
    repo's `initializeCommand` sees it (`"both"` does both). It is not added
    to the container; the repo's `devcontainer.json` forwards it with
    `${localEnv:NAME:default}` if the container needs it. For example, a step
    that never touches sub-repos sets
    `INIT_SUBREPOS: Env.value({ value: "false", applies: "setup" })` and the
    repo has `"containerEnv": { "INIT_SUBREPOS": "${localEnv:INIT_SUBREPOS:true}" }`.
    Not allowed on `Runtime.host()` steps or on a `defineMcp`'s variables.
  - `repo`: what the step does to the repository, from the `Repo` export of
    `@boboddy/sdk/definitions/steps`. A devcontainer step defaults to
    `Repo.readWrite()` (work branch, commit and push when the step succeeds; a
    failed push fails the step). `Repo.readOnly()` still clones and checks out the
    base but creates no branch, commits and pushes nothing; use it for analysis,
    triage and review steps that only read code. `Repo.readWrite({ message,
    onPushFailure })` sets the commit message and, with `onPushFailure: "warn"`,
    lets a failed push be logged instead of failing the step. A message may
    use `input` and `result`, so it is a function:
    `repo: ({ result }) => Repo.readWrite({ message: \`fix: ${result.summary}\` })`.
    `Runtime.host()` has no clone, so it takes only `Repo.none()`, which is its
    default and never needs writing. Omit `repo` unless a step needs one of these.
- **Repo config first, step config second.** A step already runs with the
  repository's own `.devcontainer/`, `.opencode/` and `.boboddy/`. Anything
  every step needs belongs there, not copied into each step. Put in a step only
  what is about that step: its runtime, its `vars`, its `repo`, the MCP servers
  it mounts and its health checks. Steps have no `plugins` option: OpenCode
  plugins go in the repository's `.opencode/opencode.json`, which every step
  loads. That file is outside this directory, so if a plugin is needed, tell
  the user what to add rather than editing it.
- **`mcps`** — the MCP servers this step runs with, each a `defineMcp` (see
  "MCP servers — `defineMcp`" below). A step gets **only** the servers it
  lists in `mcps`: every server the repository defines (see the files below)
  is turned off for a step that does not list it, even one in
  `.opencode/opencode.json`. `defineMcp` is the only way to give a step an MCP
  server or an MCP health check. `.opencode/tools/` custom tools are not MCP
  servers and still load for every `workspace` step. Skills are not chosen per
  step either: every skill under `.claude/skills/`, `.agents/skills/`,
  `.opencode/skill/` or `.opencode/skills/` in the repository is available to
  every `workspace` step.

### MCP servers — `defineMcp`

Every MCP server a step uses is a `defineMcp`: which server it is, the env
vars it needs, and its health checks, written once. Each step that uses it
mounts it under `mcps` in one line, and adjusts it for that step with the
builder methods below.

A `defineMcp` takes a `type`:

| `type`     | Use it for                                                        | Fields                                                              |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `"ref"`    | A server the repository already defines                           | `name`: its name in the repository's MCP config                     |
| `"local"`  | A server the repository does not define, launched as a subprocess | `name`, `command` (`[executable, ...args]`), `cwd?`, `environment?` |
| `"remote"` | A server the repository does not define, reached over HTTP        | `name`, `url`, `headers?`, `oauth?`                                 |

All three also take `env?`, `optionalEnv?`, `healthChecks?`, and OpenCode's
`timeout` (`{ startup, catalog, execution }` in milliseconds), `protocol` and
`codemode`. Prefer a `ref` whenever the repository defines the server.

**Define each server once per file, and override it per step.** Never write
the same server's checks or env vars into two steps: copies drift.

```ts
import { z } from "zod";
import { defineMcp, defineStep } from "@boboddy/sdk/definitions/steps";

const postgres = defineMcp({
  type: "ref",
  name: "postgres",
  healthChecks: {
    listSchemas: { tool: "list_schemas" },
    listTables: { tool: "list_tables", args: { schema: "public" }, enabled: false },
  },
});

export const triageData = defineStep({
  key: "triage-data",
  name: "Triage Data",
  status: "active",
  agentPrompt: "Use the postgres tools to find the rows behind this report.",
  mcps: { postgres },
  result: z.object({ summary: z.string() }),
});

export const explainData = defineStep({
  key: "explain-data",
  name: "Explain Data",
  status: "active",
  agentPrompt: "Explain the data problem. Query postgres if it helps.",
  mcps: {
    db: postgres
      .enableCheck("listTables")
      .overrideCheck("listSchemas", { timeoutSeconds: 30 }),
  },
  result: z.object({ summary: z.string() }),
});
```

A server the repository does not define is written inline as `local` or
`remote`. Use this for a `Runtime.host()` step too: it has no checkout, so it
cannot use a `ref`.

```ts
import { z } from "zod";
import { defineMcp, defineStep, Runtime } from "@boboddy/sdk/definitions/steps";

const warehouse = defineMcp({
  type: "local",
  name: "warehouse",
  command: ["<launch command for the server, from the user>"],
  environment: { WAREHOUSE_URL: "{env:WAREHOUSE_URL}" },
  healthChecks: { listTables: { tool: "list_tables" } },
});

const tracker = defineMcp({
  type: "remote",
  name: "tracker",
  url: "https://mcp.internal.example/tracker",
  headers: { Authorization: "Bearer {env:TRACKER_TOKEN}" },
});

export const classify = defineStep({
  key: "classify",
  name: "Classify",
  status: "active",
  environment: { runtime: Runtime.host() },
  agentPrompt: "Classify the report. Check the warehouse and tracker if it helps.",
  mcps: { warehouse, tracker },
  result: z.object({ category: z.string() }),
});
```

- `name` — for a `ref`, the server's name in the repository's MCP config. The
  `mcps` key is the name the step runs it under; mounting it under a
  different key (`db` above) aliases it. For `local` and `remote`, `name`
  only labels the server in errors; the `mcps` key names it at runtime.
- `command`, `cwd`, `environment` (`local`) and `url`, `headers`, `oauth`
  (`remote`) are OpenCode v2's `mcp.servers.<name>` fields. A `local` command
  must be resolvable **inside the execution environment** (the devcontainer
  for `workspace` steps, the worker host for `Runtime.host()`), not on the
  user's laptop. For a Playwright or Postgres server, see §10 below — do not
  invent a command for either; there is no single correct invocation.
- Every `environment` and `headers` value must be written as `{env:VAR}`
  (`"Bearer {env:TOKEN}"` is fine); `defineMcp` throws on a literal value,
  because it would be stored in plaintext. Never put a secret in `command` or
  `url` either.
- Every `{env:VAR}` in a `local` server's `command`, `cwd` or `environment`,
  or a `remote` server's `url` or `headers`, becomes a **required** worker
  variable for that server — do not list it in `env`. When the server can run
  without it, list it in `optionalEnv`.
- `healthChecks` — a record keyed by check name: `{ tool, args?,
  timeoutSeconds?, severity?, serialGroup?, enabled? }`. `tool` is the bare
  tool name; there is no `mcp` field, the step's key supplies it. Checks on
  one server run one at a time; different servers run in parallel.
  `enabled: false` defines a check a step must turn on with `enableCheck`.
- `env` — only for a server that reads `process.env` directly. A variable the
  server's definition (the repository's, for a `ref`) references as
  `{env:VAR}` is required automatically; do not list it. `optionalEnv` is
  passed through when set.

Builder methods, each returning a new server and leaving the original
untouched, so chain them freely off a shared definition:

| Method | Effect |
| --- | --- |
| `.overrideCheck(name, patch)` | Changes `tool`, `args`, `timeoutSeconds`, `severity` or `serialGroup`; `args` is replaced whole |
| `.disableCheck(name)` / `.enableCheck(name)` | Turns one check off or on; the last of the two wins, and a disabled check stays off whatever is overridden |
| `.addCheck(name, check)` | Adds a check for this step only; the name must be new |
| `.disableAllChecks()` | Turns off every check defined so far |

Severity belongs to each check, not the server: a check is `required` unless
its `severity` is `"warn"`, set in `defineMcp` or for one step with
`.overrideCheck(name, { severity: "warn" })`. A server's variables are
required unless listed in `optionalEnv`; when one is missing on the worker,
the step fails before launch.

The step's own `healthChecks` holds only `cli` checks and checks on tools that
are not MCP tools (no `mcp` field); every MCP check lives in its `defineMcp`.
A step file that also exports a
`codeStep` must keep its `defineMcp`s in that file: the code-step container
cannot resolve an extensionless relative import such as `./mcps`.

The worker resolves each `ref` against the repository only — never the user's
global OpenCode config — just before launch, first match wins:
`.opencode/opencode.json`, `.opencode/opencode.jsonc`, `opencode.json`,
`opencode.jsonc`, `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`.codex/config.toml` (all at the repository root). Each is converted to
OpenCode's shape, with `${VAR}` and `${env:VAR}` turned into `{env:VAR}`. A
`.vscode/mcp.json` server that reads an `${input:…}` prompt cannot be used,
and a literal credential in a source file is dropped. A `Runtime.host()` step
has no checkout, so it cannot use a `ref`: give it `local` or `remote`
servers. Push does not check that a ref exists; one that
matches nothing fails the step before launch, listing every file searched.
Only write a `ref` for a server you saw defined in one of those files.

### Secrets

Never write a secret **value** into a step file: it is pushed to the server,
persisted in the database, and rendered in the UI. Reference it as
`{env:VAR}` in a `local` server's `environment` or a `remote` server's
`headers` instead (`defineMcp` rejects anything else there). A `defineMcp`
server's variables (its `env`, `optionalEnv`, and every `{env:VAR}` in its
definition) are read from the worker — `.boboddy/.env` at the repository root,
then the worker's own environment — always masked in logs, and never put in
the prompt. A required one that is missing fails the step before launch.

Whenever you introduce a `{env:VAR}` reference (or a `defineMcp` `env` name)
that is new to this directory:

1. Ask the user only for the **name** of the variable (or propose a sensible
   one yourself) and how a human obtains the real value — never for the value
   itself.
2. Create `.boboddy/.env.example` — a file **one directory up** from here,
   sibling to `.boboddy/pipeline-builder/`, not inside it — if it does not
   already exist.
3. Append `VAR=` (an empty value; never a placeholder that looks real) unless
   that exact key is already present.
4. Tell the user, by variable name, in your closing summary: they must copy
   this file to `.boboddy/.env` and fill in the real value before any step
   that reads it can run.

`.boboddy/.env` itself is never a file you create or edit — it holds real
secret values, and it is the user's alone to write.

## 2. Pipelines — `definePipeline`

A pipeline is a **flat map of named states** — there is no `.step().step()`
chain to build. Each state says what kind of work it does (if any) and what
runs after it (`next`); there is no `dependsOn` anywhere — every state's
incoming edge is derived by the compiler from some other state's own forward
pointer.

```ts
import { definePipeline } from "@boboddy/sdk/definitions/pipelines";
import { investigate, writeFix } from "./steps";

export default definePipeline({
  key: "bug-repro-pipeline",
  name: "Bug Repro Pipeline",
  description: "Reproduce, then fix.",
  status: "active",
  startAt: "investigate",
  states: {
    investigate: {
      kind: "step",
      step: investigate,
      input: () => ({}),
      next: "writeFix",
    },
    writeFix: {
      kind: "step",
      step: writeFix,
      input: (ctx) => ({ investigate: ctx.output("investigate") }),
      next: "done",
    },
    done: { kind: "succeed" },
  },
});
```

Key shape rules:

- `states` is a **map keyed by node key** — the object key IS that state's
  identity; there is no separate `key` field to keep in sync with it.
- `startAt` names the entry state. It must not name a `choice`, `succeed`, or
  `fail` state — the pipeline's first move has to do real work or branch on
  the pipeline's own input, never on a predecessor that doesn't exist.
- A `kind: "step"` state takes: `step` (the step to run), an optional `input`
  mapper, and a required `next` — the state that runs after this one
  succeeds. There is no separate `.advance()` call; `next` (plus the optional
  `blockWhen` from §4) IS the advancement logic for a plain step.
- Every path through the pipeline ends at a `succeed` or `fail` state
  (`{ kind: "succeed" }` / `{ kind: "fail" }`), or hands off to a different
  pipeline entirely via `next: { routeToPipeline: "other-pipeline-key" }` —
  see §4. There is no more `"complete"` outcome string.

Optional `timeout` field on the same state object sets a per-step timeout in
seconds:

```ts fragment
investigate: { kind: "step", step: investigate, next: "writeFix", timeout: 1800 }
```

## 3. Bindings

Every state that does work (`step`, `fanOut`, a `parallel` branch, `loop`)
gets its input from exactly one place: that state's own `input` mapper,
called with a context object (`ctx`) offering every binding source. There is
no separate pipeline-level "inject into every step" layer to keep in sync
with — if two states need the same value, both mappers ask for it explicitly.

**The default binding is `ctx.output(stateKey)`: an earlier state's whole
result.** Bind the output of every earlier state the step could use, under a
field named after that state, and declare each as an `additionalInput` field
whose schema is the producer's `result` (share the `z.object` between the two
steps). A bound field the consumer does not declare is dropped. Bind only
states that run on **every** path to this one: a state on another `choice`
branch, a later state, or a `choice`/`succeed`/`fail` state (none of which has
an output) is rejected by push.

1. **Automatic, on every state** — `workItemTitle` and `workItemDescription`
   are bound automatically; you never declare them yourself.
2. **`ctx` inside a state's `input` mapper** — the only other binding surface:
   - `ctx.output(nodeKey)` — an earlier state's whole result output, addressed
     by that **state's own key** (not the step's key — two states can run the
     same step). Reach for this first.
   - `ctx.workItem.title` / `ctx.workItem.description` /
     `ctx.workItem.field("Account")` — reads directly off the current work
     item. Call this from any state that needs it; there is no separate
     "pipeline-level work-item binding" step to declare first.
   - `ctx.pipelineInput(path)` — reads a dot-path out of the pipeline's own
     `input` schema (`definePipeline({ input: z.object({...}) })`). Only
     useful if you declared one; omit `input` entirely if the pipeline takes
     none.
   - `ctx.signal(nodeKey, signalKey)` — one signal of an earlier state. Rarely
     needed: a signal exists for a rule, and `ctx.output()` already carries
     the same value.
   - `ctx.signalsList(nodeKey)` — a `fanOut`'s whole cohort (every terminal
     branch's signals + output); see the fan-out entry in §4's kind catalog.
   - `ctx.literal(value)` — a fixed value that doesn't come from anywhere at
     runtime.
   - `ctx.item` — **`fanOut` branches only** — the current branch's own item.
3. **A required `additionalInput` field forces a mapper entry that supplies
   it.** Optional fields do not (`() => ({})` is a valid mapper when
   everything it would supply is optional).

```ts
import { defineStep } from "@boboddy/sdk/definitions/steps";
import { z } from "zod";
import { definePipeline } from "@boboddy/sdk/definitions/pipelines";
import { investigate } from "./steps";

export default definePipeline({
  key: "scoped-pipeline",
  name: "Scoped",
  status: "active",
  startAt: "investigate",
  states: {
    // `ctx.workItem.field(name)` reads a work-item custom field directly —
    // there is no separate pipeline-level binding layer to keep in sync.
    investigate: {
      kind: "step",
      step: investigate,
      input: (ctx) => ({ accountRef: ctx.workItem.field("Account") }),
      next: "done",
    },
    done: { kind: "succeed" },
  },
});
```

### Traps

- **`input.workItemComments` is not a binding.** Pinned comments are injected
  on the resolved input at runtime; there is no binding form for them. Never
  map it.
- **A mapper only supplies what you write.** Unlike the retired builder,
  there is no pipeline-level layer whose bindings survive an empty mapper —
  `() => ({})` supplies nothing beyond the two automatic bindings above, full
  stop. If two states need the same value, write it in both mappers.

## 4. Advancement

`next` is the default: a `step`/`fanOut`/`parallel`/loop-success state names
the state that runs after it. Two things change that.

### Blocking — `blockWhen`

A single-condition "pause for human review" gate on a plain `step`:

```ts fragment
{
  kind: "step",
  step: triageStep,
  blockWhen: Rule.when("confidence", "lessThan", 7),
  next: "writeFixPlan",
}
```

When `blockWhen`'s condition matches, the run **blocks** in the dashboard
instead of advancing to `next`. Read it as "block when this is true" — the
inverse of writing a "continue when" condition. If your business rule is
"continue only when reproduced AND confidence ≥ 0.8", write `blockWhen` as
the negation:

```ts fragment
blockWhen: Rule.any([
  Rule.signal("reproduced", "equal", false),
  Rule.signal("confidence", "lessThan", 0.8),
]),
```

### Branching — `choice`

A `choice` state holds the whole routing table in one place — every branch's
condition and target, plus a fallback:

```ts fragment
routeBySeverity: {
  kind: "choice",
  choices: [
    { when: Rule.when("severity", "equal", "critical"), next: "pageOncall" },
  ],
  default: "fanOutFiles",
},
```

Every `choices[].next` and `default` must name another state **in this same
pipeline** — a `choice` cannot route to a different pipeline, and it cannot
block, directly. To route conditionally to one of several pipelines, point
each `choice` branch at its own small `step` state whose `next` is that
branch's `{ routeToPipeline: ... }` (below).

### Routing to another pipeline

The old `route(pipelineKey)` outcome survives as a special `next` value on a
`step`/`fanOut`/`parallel`/loop-exit (never on a `choice` branch — see above):

```ts fragment
next: { routeToPipeline: "other-pipeline-key" }
```

`routeToPipeline` must name a pipeline that already exists on the server or is
in the same push batch — push validates it and throws otherwise.

### The `Rule` DSL

`Rule.when(signalKey, operator, value)` — a bare condition, used by
`blockWhen`, a `choice` branch's `when`, and a `loop`'s `until`.

`Rule.signal(signalKey, operator, value)` — the same leaf condition, for
nesting inside `Rule.all([...])` / `Rule.any([...])`.

Operators: `"equal"`, `"notEqual"`, `"lessThan"`, `"lessThanInclusive"`,
`"greaterThan"`, `"greaterThanInclusive"`, `"in"`, `"notIn"`, `"contains"`,
`"doesNotContain"`.

```ts fragment
Rule.any([
  Rule.signal("score", "lessThan", 0.3),
  Rule.all([
    Rule.signal("reviewerApproved", "equal", false),
    Rule.signal("autoApproved", "equal", false),
  ]),
])
```

Aggregate over several numeric/boolean signals with `Computed` instead of
asking the model for one holistic number — pass it where a plain signal key
would go:

```ts fragment
Rule.signal(Computed.average(["observed", "expected", "reproduction"]), "greaterThanInclusive", 0.7)
```

`Computed.average` / `.weightedAverage` / `.sum` / `.min` / `.max` / `.count` /
`.booleanAny` / `.booleanAll` all take **two or more** signal keys.

### Other state kinds

`step` and `choice` cover most pipelines. Four more kinds exist for fan-out,
concurrency, and repetition — each is its own top-level entry in `states`,
never something you nest inside a `step`:

| Kind | What it does | Exits |
| --- | --- | --- |
| `fanOut` | Runs one step once per item in an array signal (`over`), with its own `advanceEach`/`advanceAll` cohort policy and an optional `maxConcurrency` cap. | `next`, after the whole cohort resolves |
| `parallel` | Runs several **named, single-step** branches concurrently, with an `advanceAll` cohort policy (defaults to "continue iff every branch continued"). | `next`, after every branch is terminal |
| `loop` | Repeats one step until an `until` condition matches or `maxIterations` is hit. | `next` (matched) or `onExhausted` (cap hit) |
| `succeed` / `fail` | Terminal — this run (or this branch of it) is done. No work, no `next`. | none |

```ts fragment
refineUntilPasses: {
  kind: "loop",
  step: refineStep,
  maxIterations: 5,
  until: Rule.when("passesLint", "equal", true),
  next: "publish",
  onExhausted: "escalateToHuman",
},
```

Reach for `fanOut`/`parallel`/`loop` only when a plain `step` chain can't
express the shape you need — most pipelines, including the default pipeline
in §7, are `step`/`choice`/`succeed`/`fail` only.

## 5. `default-pipeline-assignment.ts`

Decides which pipeline starts when a work item arrives. Without it, nothing
runs automatically — this file is what makes a pipeline real.

```ts
import { defaultPipelineAssignment } from "@boboddy/sdk/definitions/pipelines";
import bugPipeline from "./bug-pipeline";

export default defaultPipelineAssignment(
  ({ workItem, context, all, assign, skip }) => ({
    default: skip(),
    rules: [
      workItem.field("status").eq("resolved").then(skip()),
      all(
        workItem.field("issueType").eq("Bug"),
        context.isNew.eq(true),
      ).then(assign(bugPipeline)),
    ],
  }),
);
```

- `assign()` takes the **default export** of a pipeline file (the compiled
  spec `definePipeline()` returns).
- At least one `assign()` must exist somewhere, or push throws.
- Rules are ordered; first match wins; unmatched fall through to `default`.
- `context.isNew` is `true` on first ingestion of the work item.

## 6. Invariants — the things that actually break

1. Every `step`/`fanOut`/`parallel`/`loop` state's forward pointer (`next`,
   plus `onExhausted` for `loop`) is required — the type system enforces it
   in the same object literal. `choice` is the only kind where `next` is
   spread across `choices[].next` + `default` instead of one field.
2. A state whose step has a **required** `additionalInput` field forces an
   `input` mapper that supplies it. Optional fields do not.
3. `signals[].sourcePath` must exist in the `result` schema. **The compiler
   will not tell you.** Check by eye.
4. **No condition's signal argument is type-checked.** `blockWhen`, a
   `choice` branch's `when`, and a `loop`'s `until` all take a bare string
   signal key with no connection back to any particular step's declared
   signals — a typo compiles cleanly and fails only at execution time. This
   is looser than `ctx.signal(nodeKey, "key")` bindings, which the compiler
   does check against the reachable state keys.
5. `next: { routeToPipeline: "x" }` and `assign(...)` must name a pipeline
   that exists on the server or is in the same push batch. Push validates
   and throws otherwise.
6. A pipeline file must use `export default`. A pipeline assigned to a named
   export is silently ignored by the scanner.
7. Steps are pushed before pipelines, and pipelines before the assignment
   file — so a single `push` can introduce a pipeline and route to it in one
   go.
8. The scanner skips `push.ts` / `push.mjs` / `push.js` and
   `default-pipeline-assignment.ts`, ignores subdirectories, and only reads
   `.ts` / `.js` files.
9. Steps referenced by a pipeline are pushed even if not exported by name.
   Named exports of the same `key@version` win.
10. Use `status: "active"`. `"draft"` definitions do not execute.
11. `states` is a map, not an array — no `dependsOn` anywhere. Every incoming
    edge is derived from some other state's own `next` / `choices[].next` /
    `default` / `onExhausted`.
12. `startAt` must not name a `choice`, `succeed`, or `fail` state.
13. Any number of states may point `next` / `choices[].next` / `default` /
    `onExhausted` at the same downstream target — convergent edges are fine
    from any state kind. What's required instead: the pipeline has exactly
    one entry point, `startAt`, and every state must be reachable from it by
    following those forward edges. `definePipeline` throws at build time on
    an orphaned state it can't reach from `startAt`.

## 7. The default pipeline

Every new pipeline starts from one compile-verified file, `bug-pipeline.ts`.
The scaffold has already written it into this directory, and it is reproduced
in *The default pipeline file* at the end of this section. Do not author the
state objects from scratch and do not pick a different shape: edit that file
in place and adapt it to this repository. It is an opinionated starting point,
not a fixed one: when the user asks to change the shape, change it. What the
agent can reach changes how `investigateAndReproduce` is configured, not which
pipeline you build.

| State | Kind | What it produces |
| --- | --- | --- |
| `evaluate` | step, `Runtime.host()` | `quality` (0–1), `missingDetails[]`, a restated summary |
| `checkQuality` | `choice` on `quality < 0.1` | routes to `requestDetails`, otherwise onward |
| `requestDetails` | `codeStep`, then `insufficientDetail` (`fail`) | a comment draft asking for the missing details |
| `investigateAndReproduce` | step, devcontainer, `Repo.readOnly()` | report, `reproduced`, `reproductionConfidence` (0–1), traces, suspected root cause, evidence |
| `checkReproduction` | `choice` on `reproductionConfidence >= 0.8` | routes to `failingTest`, otherwise `notReproduced` (`fail`) |
| `failingTest` | step, devcontainer | a failing test, or `testWritten: false` with a reason |
| `proposeFix` | step, devcontainer, `Repo.readOnly()`, `blockWhen` | a fix proposal; the run blocks until a human releases it |
| `fix` | step, devcontainer | the approved fix applied, with a stated confidence |

How it is wired, and why:

- **A low bar to start.** `checkQuality` only stops reports with nothing to
  start from, so a user's first run almost always reaches the investigation.
  `requestDetails` is code, not an agent: it turns `missingDetails` into a
  `feedback_request` notification suggesting `work_item_platform_comment`,
  which becomes a draft a human approves before it is posted on the work item.
  The run then ends at `insufficientDetail`. Leave the `0.1` threshold alone.
- **Investigation is the step that matters.** Everything after it works from
  its evidence. Give it every tool the user picked in phase 3 — the browser,
  logs, a read-only database, error tracking, internal APIs — and name in its
  prompt what each one is for.
- **A high bar to write a test.** `reproductionConfidence` is the step's own
  judgement of whether it reproduced the bug and understands its cause.
  `checkReproduction` sends only a confident reproduction (`>= 0.8`) on to
  `failingTest`; anything less ends the run at `notReproduced`, with the
  investigation report as its result.
- **A human approves the fix.** `proposeFix` reads the code but changes
  nothing, and its `requiresHumanApproval` is always true, so its `blockWhen`
  always blocks. Releasing the block in the dashboard lets `fix` apply the
  approved proposal. Keep the gate unless the user asks to remove it.
- **Whole outputs, signals only for rules.** Each state's `input` binds
  `ctx.output(...)` of every earlier state on its path, and each step declares
  those fields in `additionalInput`. `quality`, `reproductionConfidence` and
  `requiresHumanApproval` are the only signals, one per rule. Add a signal only
  for a new rule.
- **Branches.** `investigateAndReproduce` and `proposeFix` are read-only, so
  they push nothing. `failingTest` commits its test on a work branch, and
  `proposeFix` and `fix` start from that branch, so the fix lands on top of the
  test.

Adapting `investigateAndReproduce` to what the agent can reach:

- **A running app it can sign in to.** Keep the Playwright server and the trace
  choreography in its prompt: set the viewport before starting the trace,
  wait after the final triggering action, stop the trace last. **Keep that
  ordering.** Stopping the trace immediately after the triggering action is
  the single most common way to lose the evidence, because delayed redirects,
  toasts, validation errors and forced logouts are the actual bug more often
  than not. Replace the URL and the sign-in instructions: tell the agent
  exactly how to obtain credentials (a named tool, named env vars, or a
  documented test account), and if it cannot, it must report auth as blocked
  rather than guess.
- **No reachable app.** There is no trace. Remove the Playwright `defineMcp`
  and its `mcps` entry, the URL and the browser procedure; have it reproduce
  from the code, the tests and the other tools, and say in its prompt that
  `tracePaths` is always empty. Rewrite what earns a `reproductionConfidence`
  above 0.8 for this case (a code path the evidence pins down, a test it could
  run), or nothing will ever reach `failingTest`.
- **Other tools the user picked** (a read-only database, logs, an internal
  API). Define each once with `defineMcp` next to `playwright`, mount it in
  the `mcps` of every step that uses it, and name in the prompt what it is
  for and when to use it.

Health checks, per §10's rules: every `defineMcp` gets a `tool` check calling
the tool the user chose. Keep a server's checks `required` when the step
cannot work without it, and set its checks to `warn` when it only helps;
change a check for one step with the builder, never by copying the server.
`investigateAndReproduce` also checks the Playwright CLI (`warn`), and
`failingTest` and `fix` each check the test runner (`required`), in their own
`healthChecks`. Replace the template's `vitest` with this repository's runner,
keeping `npx --no-install` and a flag that does no work. Drop the Playwright
CLI check along with the server when there is no reachable app.
- **Off-limits systems.** Write what must never be touched into every step's
  prompt, not just this one.

Rename keys only if the user asks, and keep `checkReproduction`'s signal key
matching the result field if you rename either; rewrite every prompt for this repository's
test framework, vocabulary and conventions — never for the seeded work item's
feature, symptom or data. The pipeline runs on every item of its kind.

## 8. Writing a good `agentPrompt`

Most of a pipeline's quality lives here.

- **Name the tools.** "Use the browser MCP tools" beats "investigate the page".
  If a specific tool exists for a specific job, say which and when.
- **Say what to do when blocked, instead of leaving it to improvisation.** An
  agent that lacks a credential, a workflow, or a term will invent one. Give it
  an explicit escape hatch: check a named source first, otherwise emit a
  `feedback_request` notification with a concrete question — never guess.
- **Ask for an honest "could not".** A step that could not reproduce the bug
  or write the test should say so in a field (`reproduced: false`,
  `testWritten: false` with a `reason`) rather than produce something that
  looks like success. The next step reads that and adjusts.
- **Demand structured evidence.** Paths, URLs, query results, log excerpts —
  concrete artifacts the next step can consume, not a narrative.
- **Explain the inputs.** For each bound field, say what it means and what to do
  when it is null or empty ("say so in your summary rather than guessing at
  scope").
- **Write for the next step.** Say who consumes each result field and what they
  need from it, in enough detail to act on.
- **Keep it operational.** Numbered procedures where order matters; prose where
  judgement matters.
- **Keep it generic.** A prompt runs on every item routed to its pipeline. It
  says how to work the item in front of it, which the agent already sees; it
  never names the ticket the pipeline was designed around.

## 9. Validate, then push

### Typecheck

The scaffolded `package.json` has a `typecheck` script and the scaffolded
`tsconfig.json` is already configured for it. Run one of these from
`.boboddy/pipeline-builder/` — whichever matches the lockfile in that directory:

```sh
# bun
bun run typecheck

# npm / pnpm / yarn
npm run typecheck
pnpm run typecheck
yarn run typecheck

# deno
deno check *.ts
```

A clean directory typechecks with zero output, so **every error you see is
yours**. `push.ts` is generated and is excluded from the typecheck.

### Push

`boboddy pipelines push` resolves `.boboddy/pipeline-builder` relative to the
**current working directory**, so it must run from the repository root:

```sh
cd ../.. && "$BOBODDY_CLI" pipelines push
```

`$BOBODDY_CLI` is the absolute path to the running CLI. If it is unset, fall
back to plain `boboddy pipelines push`.

Push order is steps → pipelines → assignment, so one command publishes a new
pipeline and the assignment that routes to it. A successful push is the finish
line: the definitions are live.
