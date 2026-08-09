---
title: Default Pipeline Assignment
description: Route incoming work items to the right pipeline automatically with default-pipeline-assignment.ts
---

The default pipeline assignment controls which pipeline is automatically started when a new work item arrives in a project. It lives in a reserved file — `.boboddy/pipeline-builder/default-pipeline-assignment.ts` — that is managed separately from regular pipeline definitions.

## File location and authoring

`boboddy pipelines init` scaffolds an example file, and `boboddy pipelines design` writes one wired to the pipeline it builds. `boboddy pipelines pull` writes or removes the file based on the server configuration. `boboddy pipelines push` syncs it back to the server when it is present.

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
    workItem.field("labels").contains("regression").then(assign(regressionReview)),
  ],
}));
```

The callback receives a context object; everything needed is destructured from it. Only `defaultPipelineAssignment` needs to be imported from the SDK.

## `default`

The outcome when no rule matches. Use `assign(pipeline)` to start a specific pipeline, or `skip()` to do nothing.

```typescript
default: assign(bugTriage)   // always start bugTriage when no rule matches
default: skip()              // do nothing when no rule matches
```

## `rules`

An ordered list of rules evaluated against each incoming work item. The first matching rule wins; unmatched items fall through to `default`.

Each rule is a condition chained with `.then(outcome)`:

```typescript
workItem.field("issueType").eq("bug").then(assign(bugTriage))
workItem.field("labels").contains("regression").then(assign(regressionReview))
workItem.field("status").eq("resolved").then(skip())
```

## Context helpers

| Helper | Description |
|--------|-------------|
| `workItem.field(name)` | Access a work item field by name. Returns a comparator ref. |
| `context.isNew` | `true` when the work item is being created for the first time. Returns a comparator ref. |
| `assign(pipeline)` | Outcome: start the given pipeline. Accepts a `PipelineDefinitionSpec` from `pipeline().build()`. |
| `skip()` | Outcome: do not assign any pipeline. |
| `all(...refs)` | All nested conditions must match. |
| `any(...refs)` | Any nested condition must match. |

## Comparators

The same comparators available in advancement policies work here:

`.eq(v)` · `.ne(v)` · `.gt(n)` · `.gte(n)` · `.lt(n)` · `.lte(n)` · `.in(values)` · `.notIn(values)` · `.contains(v)` · `.doesNotContain(v)`

## Grouping

```typescript
rules: [
  all(
    workItem.field("issueType").eq("bug"),
    workItem.field("priority").eq("high"),
  ).then(assign(bugTriage)),
  any(
    workItem.field("status").eq("resolved"),
    workItem.field("status").eq("closed"),
  ).then(skip()),
]
```

## Push and pull behaviour

- **push** — if `default-pipeline-assignment.ts` is present, its policy is synced to the server after pipelines are pushed. If the file is absent, the server configuration is left unchanged.
- **pull** — if the project has an assignment configured, `default-pipeline-assignment.ts` is written. If no assignment is configured, any existing file is removed.
- Pull fails with a clear error if the server contains rules that were not authored with the SDK fluent API and therefore cannot be reconstructed.
