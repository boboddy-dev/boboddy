# @boboddy/platform-client

## Purpose

Fetch-and-format logic for investigating a past pipeline execution: status,
attempt/step detail, logs, and artifacts, read through the Boboddy API with a
caller-supplied authenticated client. `investigateExecution` (see
`src/investigate-execution.ts`) is the entry point; `apps/cli`'s `execution
view` command is a thin argv wrapper around it, and a future MCP server can
call the same function in-process (see the plan at
`docs/plans/execution-view-cli.md`, decision 1).

This package owns the logic, not the CLI command, because two different
"apps" — the CLI today, an MCP server later — need the same behavior, and
this repo's convention is that `apps/*` stay thin argv/protocol wrappers
while `packages/*` hold the reusable logic (e.g. `pipelines push`/`pipelines
pull`'s real logic lives in `packages/worker`, not inline in
`apps/cli/src/commands/pipelines.ts`).

## Why not `@boboddy/sdk` or `packages/worker`?

Three packages in this repo talk to the Boboddy API; each has a different
audience and a different reason to exist:

| Package | Audience | Abstraction level | Release blast radius |
| --- | --- | --- | --- |
| `@boboddy/sdk` | External pipeline-definition authors, published to npm | Raw generated HTTP client (`createBoboddyClient`) plus pipeline-definition authoring helpers | Public: a breaking change ships to every consumer outside this repo |
| `packages/worker` | The CLI's write-side executor — devcontainer/Docker orchestration, running a step, pushing/pulling pipeline definitions | Built on `@boboddy/sdk`, adds auth, project config, and the whole step-execution runtime | Internal, but large — depended on by `apps/cli` directly |
| `packages/platform-client` (this package) | A human or agent debugging why an execution did what it did — read-only | Built on `@boboddy/sdk`, adds fetch-resolve-format logic for one read-heavy flow | Internal, narrow — no devcontainer/Docker/runtime dependencies |

`@boboddy/sdk` is a *published* package for pipeline-definition authors —
different audience, different release discipline — so investigation logic
that only this repo's own CLI/MCP surface consumes doesn't belong there.

`packages/worker` is chartered as the write-side executor: it orchestrates
devcontainers and Docker to actually run a step. A lightweight future MCP
binary that only wants to answer "why did this execution fail" shouldn't
have to pull in that whole runtime just to read an execution's status — the
same reasoning that already keeps `packages/worker` (also built entirely on
`@boboddy/sdk`) out of `@boboddy/sdk` itself applies one level up here.

`platform-client` depends only on `@boboddy/sdk` for the generated client's
type (`ReturnType<typeof createBoboddyClient>`) — callers resolve
authentication and construct the client themselves (see
`apps/cli/src/lib/cli-api-client.ts`'s `connectApi`) and pass both in.
