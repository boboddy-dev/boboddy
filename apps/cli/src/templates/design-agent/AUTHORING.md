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
| -------------------------------- | -------------------------------------------------------------------- |
| `<pipeline-key>.ts`              | One pipeline. Must `export default pipeline(...)…​.build()`.          |
| `steps.ts`                       | Shared steps as **named** exports. Optional; steps may live inline.   |
| `default-pipeline-assignment.ts` | Reserved. Routes incoming work items to a pipeline. Never a pipeline. |
| `push.ts`                        | Generated on every push. Never edit. Skipped by the scanner and by the typecheck. |
| `package.json`, `tsconfig.json`  | Scaffolded. `@boboddy/sdk` + `zod` are the only deps you may import.  |

Imports:

```ts
import { z } from "zod";
import { defineStep, Features } from "@boboddy/sdk/definitions/steps";
import {
  pipeline,
  defaultPipelineAssignment,
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

  // Optional on purpose: this field is supplied by a pipeline-level binding
  // (see §3). A required field here would force a mapper entry that breaks it.
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
- **`additionalInput`** — extra fields the pipeline must bind. Declaring it makes
  the pipeline-level mapper **mandatory** (see §3 for the trap this creates).
  `z.unknown()` means "no declared extra input" and keeps the mapper optional.
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
- **`mcpServers`** — per-step MCP servers:

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

## 2. Pipelines — `pipeline()`

```ts
import { z } from "zod";
import { pipeline } from "@boboddy/sdk/definitions/pipelines";
import { investigate, writeFix } from "./steps";

export default pipeline({
  key: "bug-repro-pipeline",
  name: "Bug Repro Pipeline",
  description: "Reproduce, then fix.",
  status: "active",
  additionalPipelineInput: {
    schema: z.object({ accountRef: z.string().nullable() }),
    bindings: ({ workItem }) => ({ accountRef: workItem.field("Account") }),
  },
})
  .step(investigate, () => ({}))
  .advance(({ stepSignals, all }) => ({
    default: "block",
    rules: [
      all(
        stepSignals.confidence.gte(0.8),
        stepSignals.identifiedFix.eq(true),
      ).then("continue"),
    ],
  }))
  .step(writeFix, ({ signal }) => ({
    context: signal(investigate, "rootCause"),
  }))
  .advance(() => ({ default: "complete" }))
  .build();
```

The builder is a state machine: `pipeline()` → `.step()` → `.advance()` →
(`.step()` | `.build()`). `.advance()` after every `.step()` is enforced by the
type system, and the error message is opaque ("Property 'step' does not exist
on type 'PipelineStepAdvancementBuilder'"), so recognize it on sight.

Optional third argument to `.step()` sets a per-step timeout in seconds:

```ts fragment
.step(investigate, () => ({}), (cfg) => { cfg.timeout = 1800; })
```

## 3. Bindings

Every step's input is assembled from three layers; later layers win.

1. **Automatic** — `workItemTitle` and `workItemDescription` are bound on every
   step, always. You never declare them.
2. **Pipeline-level** — injected into *every* step:
   - `additionalPipelineInput: { schema, bindings: ({ workItem, literal }) => ({…}) }`
     also gives step mappers a typed `input.<field>`.
   - `additionalStepInput: { schema, bindings: ({ workItemField, literal }) => ({…}) }`
     injects bindings only; no pipeline input schema.

   Both throw at build time if `bindings` returns a key not in `schema`.
3. **Step mapper** — the second argument to `.step()`.

Binding sources available in a step mapper: `input.<path>`, `signal(step, key)`,
`output(step)`, `literal(value)`. There is **no** `workItem` accessor in a step
mapper — work-item fields can only enter via the pipeline-level layers.

```ts
import { z } from "zod";
import { pipeline } from "@boboddy/sdk/definitions/pipelines";
import { investigate } from "./steps";

export default pipeline({
  key: "scoped-pipeline",
  name: "Scoped",
  status: "active",
  // Same effect as additionalPipelineInput, but bindings-only: no pipeline
  // input schema, and step mappers get no typed `input.accountRef`.
  additionalStepInput: {
    schema: z.object({ accountRef: z.string().nullable() }),
    bindings: ({ workItemField }) => ({ accountRef: workItemField("Account") }),
  },
})
  .step(investigate, () => ({}))
  .advance(() => ({ default: "complete" }))
  .build();
```

### Traps

- **Do not re-map a pipeline-level field inside a step mapper.** Writing
  `({ input }) => ({ accountRef: input.accountRef })` replaces the `work_item`
  binding with a `pipeline_input` binding, which resolves to `null` at runtime.
  Let the pipeline-level binding flow through untouched.
- **A step field fed by pipeline-level bindings must be optional in that step's
  `additionalInput`** (`z.string().nullable().optional()`), or absent from it
  entirely. A required field forces a mapper entry, and the only way to satisfy
  it is the broken re-map above. With the field optional, `() => ({})` is a
  valid mapper and the injected binding survives.
- **`input.workItemComments` is not a binding.** Pinned comments are injected on
  the resolved input at runtime; there is no binding form. Never map it.
- `workItemTitle`, `workItemDescription`, and `workItemComments` are rejected as
  `additionalPipelineInput` schema keys (the schema type resolves to `never`).

## 4. Advancement

`.advance(ctx => ({ default, rules? }))`. Rules are evaluated in order; the
first match wins. If none match, `default` applies.

Outcomes: `"continue"`, `"block"` (park for a human), `"complete"`, or
`route(pipelineKey, inputJson?)`.

Signal refs: `stepSignals.<key>` or `signal("<key>")` — both are type-checked
against the step's declared signal keys.

Comparators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `contains`,
`doesNotContain`.

Combinators: `all(...)`, `any(...)` — nestable, then `.then(outcome)`.

Computed aggregates over numeric signals: `avg`, `weightedAvg`, `sum`, `min`,
`max`, `count`, `booleanAny`, `booleanAll`. Each takes **two or more** signal
refs and returns something comparable.

```ts fragment
.advance(({ stepSignals, avg, any, route }) => ({
  default: "block",
  rules: [
    any(
      stepSignals.confidence.lt(0.4),
      stepSignals.reproduced.eq(false),
    ).then("block"),
    avg(stepSignals.clarity, stepSignals.evidence).gte(0.7).then("continue"),
    stepSignals.routeKey.eq("data-pipeline").then(route("data-pipeline")),
  ],
}))
```

`block` is the right default for any gate you are unsure about: it parks the
work item for a human instead of letting a low-confidence result cascade.

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

- `assign()` takes the **default export** of a pipeline file (the built spec).
- At least one `assign()` must exist somewhere, or push throws.
- Rules are ordered; first match wins; unmatched fall through to `default`.
- `context.isNew` is `true` on first ingestion of the work item.

## 6. Invariants — the things that actually break

1. Every `.step()` must be followed by `.advance()` before another `.step()` or
   `.build()`.
2. A step whose `additionalInput` has a **required** field forces a mapper that
   supplies it. Optional fields do not.
3. `signals[].sourcePath` must exist in the `result` schema. **The compiler will
   not tell you.** Check by eye.
4. Signal keys used in `.advance()` are type-checked. Signal keys used in
   `signal(step, "key")` bindings are type-checked. `sourcePath` is not.
5. `route("x")` and `assign(...)` must name a pipeline that exists on the server
   or is in the same push batch. Push validates and throws otherwise.
6. A pipeline file must use `export default`. A pipeline assigned to a named
   export is silently ignored by the scanner.
7. Steps are pushed before pipelines, and pipelines before the assignment file —
   so a single `push` can introduce a pipeline and route to it in one go.
8. The scanner skips `push.ts` / `push.mjs` / `push.js` and
   `default-pipeline-assignment.ts`, ignores subdirectories, and only reads
   `.ts` / `.js` files.
9. Steps referenced by a pipeline are pushed even if not exported by name.
   Named exports of the same `key@version` win.
10. Use `status: "active"`. `"draft"` definitions do not execute.

## 7. Archetype catalog

Pick by **what the execution environment can reach**, not by what the app is.

Every archetype has a complete, compile-verified implementation in *The
archetype files* at the end of this section. Do not author the `.step()` /
`.advance()` alternation from scratch: copy the closest file, rename its keys,
and rewrite its prompts for this user's domain.

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

Shape: `reproduce (workspace, playwright MCP)` → gate on
`reproduced == true && confidence >= 0.8` → `failing test` → gate → `fix`.

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

Shape: `failing test (workspace)` → gate on `confidence >= 0.8` → `fix`.

The reproduction step writes tests that fail for the reported reason and returns
their paths; the fix step consumes those paths as its validation target. Adapt
the prompt to name this repository's test framework and conventions explicitly.

### C. Read-only data / state investigation

**Choose when** reachability = a read-only database, warehouse, log store, or
observability MCP — and the report is about wrong, missing, or stale data rather
than broken code paths. `executionMode: "no_workspace"`, because no repository
is needed to run queries.

Shape: `investigate (no_workspace, data MCP)` → gate on
`confidence >= 0.8 && identifiedRequiredChanges == true`.

Note the split between `suspectedRootCause` (a theory) and
`identifiedRequiredChanges` (a boolean naming a specific change): the gate reads
the boolean. Replace the MCP server, and replace the work-item field that scopes
the queries with one the user actually has. To hand the fix off, swap the
`"complete"` outcome for `route("failing-test-repro")`.

### D. Triage / intake quality scoring

**Choose when** reachability = nothing. Needs no repo, no app, no data — only
the work item's title and description. `executionMode: "no_workspace"`.

Shape: `score (no_workspace)` → gate on the average of the sub-scores.

Independent dimensions are scored separately and combined with `avg(...)` in
`.advance()` rather than asking the model for one holistic number, which keeps
the sub-scores visible and the threshold tunable without touching the prompt.
Adapt the dimensions to what this user's reports should contain.

### E. Router → other pipelines

**Choose when** two or more target pipelines already exist. A router with one
target is pointless — build the target first.

Shape: `classify (no_workspace)` → `.advance()` with one
`stepSignals.routeKey.eq(k).then(route(k))` rule per target.

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
