---
title: Running Workers
description: Use boboddy work to claim and execute step jobs from the server
---

A **worker** is a long-running process that polls the Boboddy server for pending step executions, claims them under a time-limited lease, executes them using a local Docker environment, and reports results back.

## Start a worker

```bash
boboddy work
```

By default the worker runs continuously, polling your project's step queue every 5 seconds.

If your current directory contains `.boboddy/boboddy.jsonc`, the project ID is read automatically. Otherwise pass it explicitly:

```bash
boboddy work <projectId>
```

## Worker flags

| Flag                             | Alias | Default                  | Description                                                                       |
| -------------------------------- | ----- | ------------------------ | --------------------------------------------------------------------------------- |
| `--once`                         | —     | `false`                  | Poll once and wait for any claimed jobs to finish                                 |
| `--concurrency <n>`              | `-c`  | `1`                      | Maximum number of concurrently active jobs                                        |
| `--batch-size <n>`               | `-b`  | value of `--concurrency` | Maximum step executions to claim per poll cycle                                   |
| `--lease-duration-seconds <n>`   | `-l`  | `30`                     | Lease duration before the server reclaims a job                                   |
| `--poll-interval-ms <n>`         | `-p`  | `5000`                   | Milliseconds between poll cycles                                                  |
| `--worker-id <id>`               | `-w`  | auto                     | Worker identifier used while claiming steps                                       |
| `--work-item-id <id>`            | —     | —                        | Only process step executions for this work item ID                                |
| `--preserve-runtime-on-complete` | `-k`  | `false`                  | Keep runtime containers and workspace after a job finishes (useful for debugging) |

## How execution works

1. **Poll** — The worker calls the server to claim a batch of pending step executions.
2. **Claim** — Each claimed execution is assigned a lease. The worker sends heartbeats to extend the lease while processing.
3. **Environment setup** — For `workspace` steps (the default), the worker clones your repository and launches a single Docker runtime from your `.devcontainer/devcontainer.json`. Before bringing the container up, it injects mounts for a pinned, Boboddy-managed OpenCode runtime payload and a session-scoped agent home. For `no_workspace` steps, this is skipped entirely — see [Execution mode](/boboddy/guides/steps/#execution-mode).
4. **Agent startup** — For `workspace` steps, OpenCode runs **inside that same devcontainer** (same environment as your workspace), launched by absolute path from the mounted runtime payload — never the project's Node or a global `opencode`. There is no separate AI container, cross-container network, or MCP-host bridge. For `no_workspace` steps, the same Boboddy-managed OpenCode runtime runs **directly on the worker host** against a temporary empty directory — no Docker, no clone.
5. **Agent execution** — The step is handed to the in-container OpenCode agent with the step's prompt, input payload, and any configured MCP servers. Provider access is resolved through a normalized contract (currently `direct` mode: an explicit provider base URL + token, with your local OpenCode config as a fallback source).
6. **Signal extraction** — The agent's structured output is parsed; signals are extracted per the step's `signals` definition.
7. **Report** — The worker marks the execution complete (or failed) and posts output + signals back to the server.
8. **Cleanup** — The Docker environment is torn down (unless `--preserve-runtime-on-complete` is set).

## Work branches

For `workspace` steps, the worker creates a dedicated git branch for each step execution right after cloning, commits the agent's changes to it, and pushes it.

Branches are named `<prefix>/<stepKey>-<stepExecutionId>`. The prefix defaults to `boboddy`. To use your own prefix, add `branchPrefix` to the repo's `.boboddy/boboddy.jsonc`:

```jsonc
{
  "projectId": "your-project-id",
  "branchPrefix": "myteam"
}
```

With the config above, a step keyed `build` produces a branch like `myteam/build-<stepExecutionId>`.

Notes:

- The prefix is sanitized to a valid git ref (whitespace and unsafe characters become `-`). If it is missing, empty, or sanitizes to nothing, the worker falls back to `boboddy`.
- The prefix is read from the cloned repo's config on disk, so it lives alongside the code it applies to.

### Base branch

The worker always clones the repo's default branch, then creates the step's work branch off a **base branch**:

- **Later steps in a pipeline** are always created off the previous step's work branch.
- **The first step** (and standalone steps) is created off a configurable base branch. Set `baseWorkBranch` in the repo's `.boboddy/boboddy.jsonc`:

  ```jsonc
  {
    "projectId": "your-project-id",
    "baseWorkBranch": "develop"
  }
  ```

  You can override the configured value per worker with the `BOBODDY_BASE_WORK_BRANCH` env var in `.boboddy/.env`. The env var takes precedence over the jsonc field.

When no base branch is configured, the first step is created off the repo's cloned default branch. If a configured base branch cannot be fetched/checked out, the step fails.

## Environment requirements

- **Docker** must be running and accessible to the worker process — required for `workspace` steps. `no_workspace` steps do not use Docker.
- **OpenCode** must be installed and configured (`~/.config/opencode/opencode.jsonc`). See [opencode.ai/docs](https://opencode.ai/docs) for setup instructions.
- Your repo must have a `.devcontainer/devcontainer.json` (you provide this; `boboddy init` requires it but does not generate one). See [Setting up a Dev Container](/boboddy/guides/devcontainer/).
- Credentials must be present (`boboddy auth login`).

## Single-job mode

For debugging or CI use cases, run a specific work item:

```bash
boboddy work --work-item-id <id> --once --preserve-runtime-on-complete
```

This claims the specified item, runs it once, and keeps the container alive so you can inspect the execution environment.

## Clean up Docker networks

Newer single-container runs no longer create per-session Docker networks. This command remains as a maintenance utility to remove any unused Boboddy runtime networks left over from older runs:

```bash
boboddy runtime cleanup-networks
boboddy runtime cleanup-networks --verbose
```

## Authentication

Workers use credentials stored in `~/.boboddy.json`. If running in CI, set the `BOBODDY_BASE_URL` environment variable and ensure credentials are available (e.g., via a secret injected at `~/.boboddy.json`).
