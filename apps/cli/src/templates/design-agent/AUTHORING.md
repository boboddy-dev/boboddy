
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
import { defineStep, Features } from "@boboddy/sdk/definitions/steps";
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
import { defineStep, Features } from "@boboddy/sdk/definitions/steps";

export const investigate = defineStep({
  key: "investigate", // stable identity; never reuse for a different job
  name: "Investigate",
  description: "Find the root cause from logs and data.",
  status: "active",
  version: 1, // optional, defaults to 1; bump for a breaking redefinition
  executionMode: "no_workspace", // "workspace" (default) | "no_workspace"

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
    confidence: z.number().min(0).max(1),
    identifiedFix: z.boolean(),
  }),

  signals: [
    { sourcePath: "findings" },
    { sourcePath: "rootCause" },
    { sourcePath: "confidence" },
    { sourcePath: "identifiedFix" },
  ],

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
- **`result`** — the schema the agent's structured answer must satisfy. Keep it
  flat and scalar-heavy; every field you want to branch on must be a signal.
- **`signals`** — `{ sourcePath, key?, type?, required?, availableWhenResultStatusIn? }`.
  `key` defaults to `sourcePath`; `type` is inferred from the result schema;
  `required` defaults to `true`. Dot paths work: `{ sourcePath: "scores.clarity", key: "clarity" }`.
  - **`sourcePath` is NOT type-checked.** A typo compiles cleanly and fails only
    at execution time, when the extractor finds nothing. Re-read every
    `sourcePath` against the `result` schema by eye before pushing.
- **`features`** — `Features.notifications()` adds the `$boboddy_notifications_v1`
  result field, the matching prompt section, and the signal. Use it instead of
  hand-writing a notification schema.
- **`executionMode`** — `"workspace"` (default) clones the repo and runs inside the
  project devcontainer. `"no_workspace"` runs with no repo and no Docker; use it
  for classification, scoring, and any investigation that only needs MCP tools.
- **`mcpServers`** — per-step MCP servers **beyond what the project already
  configures**. Check `.opencode/opencode.json` / `.opencode/opencode.jsonc`
  and `.opencode/tools/` at the repository root first (phase 1 of the
  interview): anything declared there loads natively for every `workspace`
  step already, so only declare a server here if it is not already present.

  ```ts fragment
  mcpServers: {
    browser: {
      type: "local",
      command: ["<launch your local MCP server package here>"],
      enabled: true,
    },
    warehouse: {
      type: "remote",
      url: "https://mcp.internal.example/warehouse",
      enabled: true,
    },
  },
  ```

  For a Playwright or Postgres server specifically, see §10 below — do not
  invent a command for either; there is no single correct invocation.

  A `local` command must be resolvable **inside the execution environment**
  (the devcontainer for `workspace` steps), not on the user's laptop.

  If a server needs a secret, see "Secrets" below — never inline one into
  `command`, and never invent a placeholder that looks like a real value.

### Secrets

Never write a secret **value** into a step file: it is pushed to the server,
persisted in the database, and rendered in the UI. Reference it as
`{env:VAR}` inside `mcpServers.<server>.environment` or `.headers` instead —
OpenCode substitutes it at execution time from whatever env vars are present
in the container, which is `.boboddy/.env` at the repository root, injected as
`containerEnv`.

Whenever you introduce a `{env:VAR}` reference that is new to this directory:

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
      input: (ctx) => ({
        context: ctx.signal("investigate", "rootCause"),
      }),
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

1. **Automatic, on every state** — `workItemTitle` and `workItemDescription`
   are bound automatically; you never declare them yourself.
2. **`ctx` inside a state's `input` mapper** — the only other binding surface:
   - `ctx.workItem.title` / `ctx.workItem.description` /
     `ctx.workItem.field("Account")` — reads directly off the current work
     item. Call this from any state that needs it; there is no separate
     "pipeline-level work-item binding" step to declare first.
   - `ctx.pipelineInput(path)` — reads a dot-path out of the pipeline's own
     `input` schema (`definePipeline({ input: z.object({...}) })`). Only
     useful if you declared one; omit `input` entirely if the pipeline takes
     none.
   - `ctx.signal(nodeKey, signalKey)` — an earlier state's signal, addressed
     by that **state's own key** (not the step's key — two states can run the
     same step).
   - `ctx.output(nodeKey)` — an earlier state's whole result output.
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
each `choice` branch at its own small `step` state that does the routing —
see the router archetype in §7E, which is the worked example for exactly this.

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
express the shape you need — most pipelines, including every archetype in
§7, are `step`/`choice`/`succeed`/`fail` only.

## 5. `default-pipeline-assignment.ts`

Decides which pipeline starts when a work item arrives. Without it, nothing
runs automatically — this file is what makes a pipeline real.

```ts
import { defaultPipelineAssignment } from "@boboddy/sdk/definitions/pipelines";
import browserRepro from "./browser-repro";

export default defaultPipelineAssignment(
  ({ workItem, context, all, assign, skip }) => ({
    default: skip(),
    rules: [
      workItem.field("status").eq("resolved").then(skip()),
      all(
        workItem.field("issueType").eq("Bug"),
        context.isNew.eq(true),
      ).then(assign(browserRepro)),
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

## 7. Archetype catalog

Pick by **what the execution environment can reach**, not by what the app is.

Every archetype has a complete, compile-verified implementation in *The
archetype files* at the end of this section. Do not author the state objects
from scratch: copy the closest file, rename its keys, and rewrite its
prompts for this user's domain.

| Reachability                              | Archetype                   | File                     |
| ----------------------------------------- | --------------------------- | ------------------------ |
| A running URL + a way to authenticate     | A — Browser repro           | `browser-repro.ts`       |
| Repo only; nothing runnable               | B — Failing-test repro      | `failing-test-repro.ts`  |
| A read-only data or observability surface | C — Read-only investigation | `data-investigation.ts`  |
| Nothing but the work item text            | D — Intake scoring          | `intake-triage.ts`       |
| Two or more pipelines already exist       | E — Router                  | `router.ts`              |

### A. Browser / deployed-app reproduction

**Choose when** reachability = a URL the execution environment can load, plus
credentials it can obtain. Not for apps that only run on a developer laptop.

Shape: `reproduce (workspace, playwright MCP)` → blocks unless
`reproduced == true && confidence >= 0.8` → `failing test` → blocks unless
confident → `fix`.

The reproduction prompt encodes a hard-won choreography — set the viewport
before starting the trace, wait after the final triggering action, stop the
trace last. **Keep that ordering when you adapt it.** Stopping the trace
immediately after the triggering action is the single most common way to lose
the evidence, because delayed redirects, toasts, validation errors and forced
logouts are the actual bug more often than not.

You must replace: the URL, and the credential instructions. Tell the agent
exactly how to obtain credentials — a named tool, named env vars, or a
documented test account. If it cannot, it must report auth as blocked rather
than guess.

### B. Code-level failing-test reproduction

**Choose when** reachability = the repository only. No running app, no
deployment, no database. This is the safe default for backend services,
libraries, CLIs, embedded code, and any system that cannot be stood up.

Shape: `failing test (workspace)` → blocks unless `confidence >= 0.8` →
`fix`.

The reproduction step writes tests that fail for the reported reason and returns
their paths; the fix step consumes those paths as its validation target. Adapt
the prompt to name this repository's test framework and conventions explicitly.

### C. Read-only data / state investigation

**Choose when** reachability = a read-only database, warehouse, log store, or
observability MCP — and the report is about wrong, missing, or stale data rather
than broken code paths. `executionMode: "no_workspace"`, because no repository
is needed to run queries.

Shape: `investigate (no_workspace, data MCP)` → blocks unless
`confidence >= 0.8 && identifiedRequiredChanges == true`.

Note the split between `suspectedRootCause` (a theory) and
`identifiedRequiredChanges` (a boolean naming a specific change): the gate reads
the boolean. Replace the MCP server, and replace the work-item field that scopes
the queries with one the user actually has. To hand the fix off, replace the
`next: "done"` target with `next: { routeToPipeline: "failing-test-repro" }`.

### D. Triage / intake quality scoring

**Choose when** reachability = nothing. Needs no repo, no app, no data — only
the work item's title and description. `executionMode: "no_workspace"`.

Shape: `score (no_workspace)` → blocks unless the average of the sub-scores
clears the bar.

Independent dimensions are scored separately and combined with
`Computed.average(...)` inside `blockWhen` rather than asking the model for
one holistic number, which keeps the sub-scores visible and the threshold
tunable without touching the prompt. Adapt the dimensions to what this user's
reports should contain.

### E. Router → other pipelines

**Choose when** two or more target pipelines already exist. A router with one
target is pointless — build the target first.

Shape: `classify (no_workspace)` → blocks unless confident → a `choice` state
picks one of the target pipelines by the classified `routeKey` → a tiny
`dispatch` state per target that does no real work of its own, whose only job
is to carry that target's `next: { routeToPipeline: ... }` (a `choice` branch
can only target another state in this pipeline — see §4 — so reaching a
different pipeline conditionally needs one such state per target).

`routeKey` is constrained by `z.enum([...])` whose members are the exact pipeline
keys, and those keys are repeated with selection criteria in the prompt. Replace
both lists with the user's real pipeline keys. Push targets first (or in the same
batch) — push validates route keys and throws otherwise.

Note that `router.ts` builds a pipeline keyed `work-item-router`; unlike the
others, its filename stem is not its key.

## 8. Writing a good `agentPrompt`

Most of a pipeline's quality lives here.

- **Name the tools.** "Use the browser MCP tools" beats "investigate the page".
  If a specific tool exists for a specific job, say which and when.
- **Say what to do when blocked, instead of leaving it to improvisation.** An
  agent that lacks a credential, a workflow, or a term will invent one. Give it
  an explicit escape hatch: check a named source first, otherwise emit a
  `feedback_request` notification with a concrete question — never guess.
- **Define confidence.** "Confidence from 0 to 1" is meaningless on its own.
  Write what 0 and 1 mean for *this* step ("how confident you are that the
  failing test genuinely captures the reported bug"), and tell it to score low
  when unsure. Every gate you write depends on this being calibrated.
- **Split judgement from evidence.** A boolean like `reproduced` or
  `identifiedRequiredChanges` gates cleanly; a prose summary does not. Ask for
  both and gate on the boolean.
- **Demand structured evidence.** Paths, URLs, query results, log excerpts —
  concrete artifacts the next step can consume, not a narrative.
- **Explain the inputs.** For each bound field, say what it means and what to do
  when it is null or empty ("say so in your summary rather than guessing at
  scope").
- **Write for the next step.** Say who consumes each result field and what they
  need from it, in enough detail to act on.
- **Keep it operational.** Numbered procedures where order matters; prose where
  judgement matters.

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
