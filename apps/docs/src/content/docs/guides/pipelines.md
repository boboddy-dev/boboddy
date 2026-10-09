---
title: Building Pipelines
description: Wire steps into a flat, named-state graph with typed bindings and pipeline-level input
---

A **pipeline** is a flat map of named **states**. Each state says what work it does (if any) and what runs after it — there's no separate ordering to keep in sync; the graph is entirely derived from each state's own forward pointer (`next`, or a `choice`/`loop` state's own routing fields).

See the [Pipeline Graph catalog entry](/boboddy/catalog/pipeline-graph/) for an interactive view of what a compiled pipeline's node/edge graph looks like.

## Basic pipeline

Define a pipeline with `definePipeline()`. `startAt` names the entry state, and `states` is an object keyed by each state's own unique key — that object key *is* the state's identity; there's no separate `key` field to keep in sync with it.

```typescript
import { definePipeline } from "@boboddy/sdk/definitions/pipelines";
import { reviewCodeStep } from "./steps";

export default definePipeline({
  key: "code-quality-pipeline",
  name: "Code Quality Pipeline",
  status: "active",
  startAt: "review",
  states: {
    review: {
      kind: "step",
      step: reviewCodeStep,
      input: (ctx) => ({
        title: ctx.workItem.title,
        code: ctx.workItem.description,
      }),
      next: "done",
    },
    done: { kind: "succeed" },
  },
});
```

Every path through the pipeline ends at a `succeed` or `fail` state (`{ kind: "succeed" }` / `{ kind: "fail" }`), or hands off to a different pipeline entirely — see [Routing to another pipeline](#routing-to-another-pipeline).

## Scaffold pipeline definitions

Pipeline files live in `.boboddy/pipeline-builder/`. To edit what's already on the server by hand, the loop is [`boboddy pipelines pull`](/boboddy/reference/cli/#boboddy-pipelines-pull-projectid) → install dependencies → `npm run typecheck` → [`boboddy pipelines push`](/boboddy/reference/cli/#boboddy-pipelines-push-projectid). To start from nothing, see [`boboddy pipelines init`](/boboddy/reference/cli/#boboddy-pipelines-init) for when to use `design` instead.

## `definePipeline()` options

| Field         | Type                  | Required | Description                                                       |
| ------------- | --------------------- | -------- | ------------------------------------------------------------------- |
| `key`         | `string`              | Yes      | Unique identifier for this pipeline                               |
| `name`        | `string`              | No       | Human-readable display name (defaults to `key`)                   |
| `version`     | `number`              | No       | Version number (defaults to 1)                                    |
| `description` | `string`              | No       | Brief description                                                 |
| `status`      | `"draft" \| "active"` | No       | Draft pipelines are not executed                                  |
| `input`       | `ZodType`             | No       | Schema for the pipeline's own input, read via `ctx.pipelineInput(path)` |
| `startAt`     | `string`              | Yes      | The entry state's key. Must not name a `choice`, `succeed`, or `fail` state |
| `states`      | `Record<string, ...>` | Yes      | Every state in the pipeline, keyed by its unique state key         |

## States

Eight state kinds cover every pipeline shape. `step` and `choice` cover most pipelines; the rest exist for fan-out, concurrency, repetition, and forking.

| Kind | What it does | Exits |
| --- | --- | --- |
| `step` | Runs one step, with an optional `blockWhen` gate | `next` |
| `choice` | Routes to one of several states by condition | `choices[].next` / `default` |
| `fanOut` | Runs one step once per item in an array signal | `next`, after the whole cohort resolves |
| `parallel` | Runs several named, single-step branches concurrently | `next`, after every branch is terminal |
| `loop` | Repeats one step until a condition matches or an iteration cap is hit | `next` (matched) or `onExhausted` (cap hit) |
| `split` | Forks into every named branch, unconditionally — no join, no reconvergence | `branches`, all firing at once |
| `succeed` | Terminal — this run finished successfully | none |
| `fail` | Terminal — this run finished unsuccessfully | none |

`blockWhen`, `choice`'s `when`, and `loop`'s `until` all use the `Rule` DSL — see [Pipeline Advancement](/boboddy/guides/pipeline-advancement/).

### `step`

```typescript
review: {
  kind: "step",
  step: reviewCodeStep,
  input: (ctx) => ({ code: ctx.workItem.description }),
  timeout: 120,
  next: "done",
}
```

| Field       | Type                          | Required | Description                                                  |
| ----------- | ----------------------------- | -------- | -------------------------------------------------------------- |
| `step`      | step definition                | Yes      | The step to run, from `defineStep()` or `codeStep()`         |
| `input`     | `(ctx) => bindings`            | No       | Input bindings — see [Bindings](#bindings)                   |
| `timeout`   | `number \| null`               | No       | Caps how long a worker can spend on the step, in seconds      |
| `blockWhen` | `RuleCondition`                | No       | Pause for human review when this condition matches            |
| `next`      | `string \| { routeToPipeline }`| Yes      | The state that runs after this one succeeds                   |

There's no separate `.advance()` call: `next` (plus the optional `blockWhen`) *is* the advancement logic for a plain step.

### `succeed` / `fail`

```typescript
done: { kind: "succeed" }
```

No fields besides `kind`. Every pipeline needs at least one reachable terminal state.

## Bindings

Every state that does work (`step`, `fanOut`, a `parallel` branch, `loop`) gets its input from exactly one place: that state's own `input` mapper, called with a context object offering every binding source. There is **no pipeline-level "inject into every step" layer** — if two states need the same value, both mappers ask for it explicitly.

`workItemTitle` and `workItemDescription` are bound automatically on every state; you never declare them yourself. Beyond that, the `input` mapper's `ctx` offers:

### `ctx.workItem` — work item fields

```typescript
input: (ctx) => ({
  title: ctx.workItem.title,
  body: ctx.workItem.description,
  team: ctx.workItem.field("Team"),
})
```

`ctx.workItem.title` / `ctx.workItem.description` read the work item directly. `ctx.workItem.field(name)` reads a named custom field.

### `ctx.pipelineInput(path)` — the pipeline's own input

Only useful if `definePipeline({ input: z.object({...}) })` declares a schema; omit `input` entirely if the pipeline takes none.

```typescript
export default definePipeline({
  key: "ticket-analyzer",
  name: "Ticket Analyzer",
  input: z.object({ storyPoints: z.number().nullable() }),
  startAt: "analyze",
  states: {
    analyze: {
      kind: "step",
      step: analyzeStep,
      input: (ctx) => ({ storyPoints: ctx.pipelineInput("storyPoints") }),
      next: "done",
    },
    done: { kind: "succeed" },
  },
});
```

### `ctx.signal(nodeKey, signalKey)` — an earlier state's signal

Addressed by that **state's own key**, not the step's key — two states can run the same step.

```typescript
input: (ctx) => ({
  previousScore: ctx.signal("review", "clarity_score"),
})
```

### `ctx.output(nodeKey)` — an earlier state's whole output

```typescript
input: (ctx) => ({ reviewResult: ctx.output("review") })
```

### `ctx.literal(value)` — a hardcoded constant

```typescript
input: (ctx) => ({ model: ctx.literal("gpt-4o") })
```

### `ctx.signalsList(nodeKey)` — a fan-out's whole cohort

Available from any state after a [fan-out](#fan-out-parallel-branches)'s cohort resolves, even non-adjacent ones. Resolves to every terminal branch's signals, aggregated server-side.

```typescript
input: (ctx) => ({ reviews: ctx.signalsList("fanOutReviewers") })
```

### `ctx.item` — the current fan-out branch's own item

`fanOut` branches only — see [Fan-out](#fan-out-parallel-branches).

:::caution
No condition's signal argument is type-checked. `blockWhen`, a `choice` branch's `when`, and a `loop`'s `until` all take a bare string signal key with no connection back to any particular step's declared signals — a typo compiles cleanly and fails only at execution time. This is looser than `ctx.signal(nodeKey, "key")` bindings, which the compiler does check against the reachable state keys.
:::

## Plugins in pipeline steps

Opencode plugins are configured on the `defineStep()` itself, not on a state's `input` option. When that step runs inside a pipeline, Boboddy merges the step's `plugins` array into the generated Opencode config for that execution.

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

Set `timeout` on a `step`/`fanOut`/`loop` state to cap how long a worker can spend on it, in seconds:

```typescript
heavyAnalysis: {
  kind: "step",
  step: heavyAnalysisStep,
  input: (ctx) => ({ payload: ctx.pipelineInput("payload") }),
  timeout: 120,
  next: "done",
}
```

## Fan-out: parallel branches

A `fanOut` state runs one step once for every item in an array signal — think "review each of the N reviewers" or "process each of the N files" — instead of the single fixed execution a `step` state gives you. It always compiles to a `fanOut` node paired with a `cohortGate` node immediately after it.

```typescript
import { definePipeline } from "@boboddy/sdk/definitions/pipelines";

export default definePipeline({
  key: "code-review",
  name: "Code Review",
  startAt: "triage",
  states: {
    triage: { kind: "step", step: triageStep, next: "fanOutReviewers" },
    fanOutReviewers: {
      kind: "fanOut",
      step: reviewStep,
      over: "reviewer_count",
      maxConcurrency: 4,
      advanceEach: () => ({ default: "continue" }),
      advanceAll: (ctx) => ({
        default: "block",
        rules: [ctx.branchOutcomes.every("continue").then("continue")],
      }),
      next: "report",
    },
    report: {
      kind: "step",
      step: reportStep,
      input: (ctx) => ({ reviews: ctx.signalsList("fanOutReviewers") }),
      next: "done",
    },
    done: { kind: "succeed" },
  },
});
```

`over`'s resolved signal shape decides the branch mode. A number-typed signal (like `reviewer_count` above) resolves a fixed branch count, with no `ctx.item` in the `input` mapper. An array-typed signal resolves branch count from the array's length and makes `ctx.item` — the array's element type — available to every branch's `input` mapper:

```typescript
fanOutAssignees: {
  kind: "fanOut",
  step: assigneeReviewStep,
  over: "analyze.assigneeIds", // an array-typed signal — the "stateKey.signalKey" form is documentation only
  input: (ctx) => ({
    assigneeId: ctx.item,
    ticketTitle: ctx.workItem.title,
  }),
  advanceEach: () => ({ default: "continue" }),
  advanceAll: () => ({ default: "continue" }),
  next: "done",
}
```

### `FanOutState`

| Field           | Type                       | Required | Description                                                                                             |
| --------------- | -------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `step`          | step definition             | Yes      | The step to run once per item                                                                          |
| `over`          | `string`                   | Yes      | Signal whose value determines branch count (and, if array-typed, each branch's `ctx.item`) at runtime  |
| `maxConcurrency`| `number \| null`           | No       | Caps how many branches release to the claim pool up front                                              |
| `input`         | `(ctx) => bindings`        | No       | Input bindings; same context as a `step` state's mapper, plus `ctx.item`                                |
| `timeout`       | `number \| null`           | No       | Per-branch timeout in seconds                                                                            |
| `advanceEach`   | `(ctx) => result`          | Yes      | Every branch's own continue/block decision, evaluated against that branch's own signals                |
| `advanceAll`    | `(ctx) => result`          | Yes      | The whole cohort's continue/block decision, once every branch has settled                               |
| `next`          | `string`                   | Yes      | The state that runs once the whole cohort resolves                                                      |

See [Pipeline Advancement](/boboddy/guides/pipeline-advancement/#fan-out-cohort-advancement-advanceeach--advanceall) for the full `advanceEach`/`advanceAll` callback contexts.

## Parallel branches

A `parallel` state runs several **named, single-step** branches concurrently — unlike `fanOut`, the branch count is fixed at author time and each branch can run a different step.

```typescript
gather: {
  kind: "parallel",
  branches: {
    reviewA: { step: reviewStep, input: (ctx) => ({ code: ctx.workItem.description }) },
    reviewB: { step: reviewStep, input: (ctx) => ({ code: ctx.workItem.description }) },
  },
  advanceAll: (ctx) => ({
    default: "block",
    rules: [ctx.branchOutcomes.every("continue").then("continue")],
  }),
  next: "done",
}
```

| Field        | Type                                          | Required | Description                                                        |
| ------------ | ---------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `branches`   | `Record<string, { step, input?, timeout? }>`   | Yes      | Named branches; requires at least one                              |
| `advanceAll` | `(ctx) => result`                              | No       | Defaults to "continue iff every branch continued" when omitted     |
| `next`       | `string`                                       | Yes      | The state that runs once every branch is terminal                  |

## Loop

A `loop` state repeats one step until an `until` condition matches or `maxIterations` is hit.

```typescript
refineUntilPasses: {
  kind: "loop",
  step: refineStep,
  maxIterations: 5,
  until: Rule.when("passesLint", "equal", true),
  next: "publish",
  onExhausted: "escalateToHuman",
}
```

| Field           | Type                | Required | Description                                                    |
| --------------- | ------------------- | -------- | ------------------------------------------------------------------ |
| `step`          | step definition      | Yes      | The step to repeat                                              |
| `maxIterations` | `number`            | Yes      | Iteration cap                                                    |
| `input`         | `(ctx) => bindings` | No       | Input bindings, evaluated fresh on every iteration               |
| `timeout`       | `number \| null`    | No       | Per-iteration timeout in seconds                                 |
| `until`         | `RuleCondition`     | Yes      | Tested after each iteration; matching exits the loop successfully |
| `next`          | `string`            | Yes      | The state that runs when `until` matches                         |
| `onExhausted`   | `string`            | Yes      | The state that runs when `maxIterations` is hit first             |

## Branching: `choice`

A `choice` state routes to the first state in the same pipeline whose condition matches, or to its `default` — see [Branching: `choice`](/boboddy/guides/pipeline-advancement/#branching-choice).

## Split: unconditional fork

A `split` state forks into every named branch at once — unlike `choice`, there's no condition and no single winner. Each branch is an ordinary, independent chain of states (any kind, any depth) that runs to its own terminal state; there's no `next` on the `split` itself and no join back into a shared continuation. Reach for it when one step's output needs to kick off more than one independent thing — for example, firing a notification and recording evidence off the same review step, where the notification is a dead end but evidence-recording needs to keep going into the rest of the pipeline:

```typescript
reviewComplete: {
  kind: "split",
  branches: ["notifyChannel", "recordEvidence"],
},
notifyChannel: {
  kind: "step",
  step: notifyStep,
  input: (ctx) => ({ channel: ctx.workItem.field("Channel") }),
  next: "notified",
},
notified: { kind: "succeed" },
recordEvidence: {
  kind: "step",
  step: recordEvidenceStep,
  input: (ctx) => ({ reviewOutcome: ctx.output("review") }),
  next: "done",
},
done: { kind: "succeed" },
```

| Field      | Type       | Required | Description                                                                 |
| ---------- | ---------- | -------- | ------------------------------------------------------------------------------ |
| `branches` | `string[]` | Yes      | Every target state key; each starts its own independent chain. At least two required |

The pipeline run only completes once every branch — recursively, through any nested `split`s — reaches its own `succeed`/`fail`; no chain is cancelled early just because a sibling finished first. If any branch fails, the whole run is reported failed, even if a faster sibling branch already succeeded.

No two branches may reconverge on the same state, directly or several hops downstream — push validates this and rejects the definition, since `split` has no join to safely absorb it.

## Routing to another pipeline

A `next` can be `{ routeToPipeline: "<pipeline-key>" }` instead of a state key, handing the run off to a different pipeline — see [Routing to another pipeline](/boboddy/guides/pipeline-advancement/#routing-to-another-pipeline).

## See also

- [Pipeline Advancement](/boboddy/guides/pipeline-advancement/) — `blockWhen`, `choice`, the `Rule`/`Computed` DSL, and fan-out cohort advancement.
- [Default Pipeline Assignment](/boboddy/guides/pipeline-assignment/) — routing incoming work items to a pipeline automatically.
