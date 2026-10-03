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
3. **Environment setup** — For `Runtime.devcontainer()` steps (the default), the worker clones your repository and launches a single Docker runtime from your devcontainer config: `.devcontainer/devcontainer.json` unless the step selects another with [`Runtime.devcontainer({ config })`](#devcontainer-config). Before bringing the container up, it injects mounts for a pinned, Boboddy-managed OpenCode runtime payload and a session-scoped agent home. For `Runtime.host()` steps, this is skipped entirely — see [Runtime](/boboddy/guides/steps/#runtime).
4. **Agent startup** — For `Runtime.devcontainer()` steps, OpenCode runs **inside that same devcontainer** (same environment as your workspace), launched by absolute path from the mounted runtime payload — never the project's Node or a global `opencode`. There is no separate AI container, cross-container network, or MCP-host bridge. For `Runtime.host()` steps, the same Boboddy-managed OpenCode runtime runs **directly on the worker host** against a temporary empty directory — no Docker, no clone.
5. **Agent execution** — The step is handed to the in-container OpenCode agent with the step's prompt, input payload, and any configured MCP servers. Provider access is resolved through a normalized contract (currently `direct` mode: an explicit provider base URL + token, with your local OpenCode config as a fallback source).
6. **Signal extraction** — The agent's structured output is parsed; signals are extracted per the step's `signals` definition.
7. **Report** — The worker marks the execution complete (or failed) and posts output + signals back to the server.
8. **Cleanup** — The Docker environment is torn down (unless `--preserve-runtime-on-complete` is set).

### Devcontainer config

A step selects a non-default devcontainer config with `Runtime.devcontainer({ config })`, where `config` is the full repo-relative path to the file. The worker resolves it in the clone, on the branch the step is based on, before the container launches. An explicit config has **no fallback**: if it is missing, the step fails without launching anything, and the failure names the path and that branch:

```
Devcontainer config ".devcontainer/frontend/devcontainer.json" not found in the cloned repository (branch "boboddy/build-frontend-1234")
```

The branch in the message is the one the step was created off: your base branch for the first write step (see [Base branch](#base-branch)), or the work branch of the nearest earlier step that produced one for a later step. If a step expects a config that an earlier step is supposed to add, check that branch. A config path that resolves outside the clone (for example through a symlink) is rejected with `... resolves outside the cloned repository`. A `--dry-run` for the step resolves the same config, so a wrong path shows up in the dry-run report.

The worker patches the config it launches (mounts, ports, and `containerEnv`), and does not commit that patched file to the step's work branch. See [Selecting a devcontainer config](/boboddy/guides/steps/#selecting-a-devcontainer-config) and [Multiple configs](/boboddy/guides/devcontainer/#multiple-configs).

## Work branches

For devcontainer steps that use [`Repo.readWrite()`](/boboddy/guides/steps/#repo-access) (the default), the worker creates a dedicated git branch for each step execution right after cloning, commits the agent's changes to it, and pushes it. What a step does with the repository is set by its `repo` option: see [Read-only steps](#read-only-steps) and [Commit message and push failures](#commit-message-and-push-failures) below.

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

### Read-only steps

A step with `Repo.readOnly()` still clones the repo and checks out its base branch (see [Base branch](#base-branch)), but the worker creates no work branch, commits nothing, and pushes nothing. The execution reports no work branch, so no branches pile up on your remote for steps that only read code. Edits the agent makes stay in the workspace and are discarded with it. This is a policy, not a sandbox: the repository is not mounted read-only.

A step with `Repo.none()` (the `Runtime.host()` default) never clones, so none of this applies to it.

### Commit message and push failures

The commit message defaults to `boboddy: step <stepExecutionId>`. A step sets its own with `Repo.readWrite({ message })`, rendered from the step's input and the result the agent submitted. The rendered subject is single-line, at most 200 characters, and falls back to the default when empty. The same message is used for submodule commits. See [Repo access](/boboddy/guides/steps/#repo-access) for the token rules.

:::caution[Behavior change: a failed push now fails the step]
Previously the worker logged a failed push and carried on, so a step could finish green with its work pushed nowhere. Now a failed push of the work branch, or of a submodule's work branch, **fails the step** with a message that names the branch and carries the git error, for example `Failed to push work branch "boboddy/build-1234": <git error>`. This applies to every `readWrite` step, including steps that never wrote a `repo`. Existing steps get `onPushFailure: "fail"` recorded when the database is migrated.

The step fails before it is reported complete, so the result the agent submitted is **discarded** along with the push. A rerun repeats the agent run.

To keep the old behavior for a step whose work is expendable, opt out:

```typescript
environment: {
  repo: Repo.readWrite({ onPushFailure: "warn" }),
},
```

With `"warn"` the failure is logged and the step finishes as before, except that it reports **no work branch**: the branch is not on the remote, so a later step does not build on it (see [Base branch](#base-branch)) and its work is not handed on. A submodule whose push failed is still left out of the superproject commit, so the superproject never records a commit that cannot be fetched.
:::

`readOnly` and `none` steps never push, so they are not affected.

### Base branch

The worker always clones the repo's default branch, then creates the step's work branch off a **base branch**:

- **Later steps in a pipeline** are created off the work branch of the nearest earlier step, in the same pipeline run attempt, that produced one. The server hands this branch to the worker, and it takes precedence over `--source-branch` and the configured base.
- **The first write step** in a pipeline (nothing upstream produced a branch) and **standalone steps** are created off a base branch resolved with the following precedence:
  1. **Your current local branch.** `boboddy work` resolves the branch you're on in the directory you ran it from and checks it out immediately after clone — so the devcontainer config and everything the step runs against comes from the branch you're actually working on, not the repo's default branch. Before proceeding, the CLI verifies your current branch exists on `origin` and is in exact sync with it (not just an ancestor/descendant); if it isn't pushed, has diverged, or doesn't exist on `origin` at all, the command fails fast with a message telling you what to do — it never auto-pushes on your behalf. Use `--source-branch <branch>` to target a different branch instead (e.g. from CI, or a colleague's branch) — an override only needs to exist on `origin`, not be checked out locally. `--dry-run` performs the same resolution and checks.
  2. **A configured base branch**, when your current branch can't be resolved (e.g. `boboddy work` isn't run from inside a git checkout, or `HEAD` is detached). Set `baseWorkBranch` in the repo's `.boboddy/boboddy.jsonc`:

     ```jsonc
     {
       "projectId": "your-project-id",
       "baseWorkBranch": "develop"
     }
     ```

     You can override the configured value per worker with the `BOBODDY_BASE_WORK_BRANCH` env var in `.boboddy/.env`. The env var takes precedence over the jsonc field.
  3. **The repo's cloned default branch**, when neither of the above applies.

How the predecessor is chosen:

| Situation                                                                                         | Base                                                                                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Earlier step wrote a work branch                                                                  | That branch                                                                                               |
| Earlier step is `readOnly` or `none` (no work branch), or a decision (choice, split, cohort gate) | Skipped: the walk continues to that node's predecessors                                                   |
| Earlier step failed or is otherwise unsatisfied                                                   | Ignored; only satisfied runs count. A rerun's inherited satisfied runs keep their branch                  |
| Loop iteration after the first                                                                    | The previous iteration's branch, when it wrote one                                                        |
| Node after a loop                                                                                 | The last iteration that wrote a branch                                                                    |
| Branches of a `parallel` or `fanOut` node                                                         | All share the fork point's base                                                                           |
| Node after a join where more than one branch wrote a work branch                                  | No single base: falls back to the source branch, configured base, then default; the server logs a warning |
| Nothing upstream wrote a branch                                                                   | The precedence above                                                                                      |
| Earlier step used `onPushFailure: "warn"` and its push failed                                     | It reported no branch, so it is treated as if it produced none                                            |

If the resolved base branch cannot be fetched/checked out (for example it was deleted from the remote between steps), the step fails.

## Git cache

To avoid a full network clone for every step, the worker keeps a local bare mirror of your repo on the worker machine and clones each step's workspace from it. The mirror is refreshed from your real remote before each clone, and the workspace's `origin` is still your real remote, so pushes behave exactly as before. If the cache can't be used for any reason (offline, a repo URL that embeds a password or token, a lock timeout), the worker logs `git-cache: falling back to plain clone (<reason>)` in the step log and does a normal clone.

| Env var                 | Description                                                    | Default                |
| ----------------------- | -------------------------------------------------------------- | ---------------------- |
| `BOBODDY_GIT_CACHE`     | `on` or `off`. Any other value stops the worker with an error. | `on`                   |
| `BOBODDY_GIT_CACHE_DIR` | Absolute path of the directory that holds the mirrors          | `~/.boboddy/git-cache` |

Both can be set in the environment or in `.boboddy/.env` (the latter wins). There is no size limit; it is always safe to delete the cache directory, and it is rebuilt on demand.

Only your repo itself is cached. Submodules are not touched. When the cache is on, the worker passes `BOBODDY_GIT_CACHE_DIR` to the host-side environment of your devcontainer's `initializeCommand`, so a script in your repo can opt in to reusing the mirrors. Such a script must tolerate a missing mirror and treat the cache as read-only.

## Step environment variables

A step can declare the environment variables it needs with [`environment.vars`](/boboddy/guides/steps/#environment-variables). The worker handles them in three stages:

1. **Resolution.** Right after claiming an execution and fetching its definition, and before anything launches, the worker resolves the declared variables into one set of values. `value` entries are rendered against the run's input. `inherit` entries are read from the worker's environment: `.boboddy/.env` merged over the worker's `process.env`, then the entry's `default`. A variable set to an empty string counts as set.
2. **Injection.** The resolved values are passed to the agent and to code steps. With `Runtime.devcontainer()` they are added to the in-container OpenCode process (and a code step's runner) as `docker exec -e` arguments, so they override the devcontainer's `containerEnv`. With `Runtime.host()` they are merged into the host process's environment. Only variable names are logged, never values.
3. **Masking.** Values of `secret` entries are registered with the log masker before any runtime log is shipped. Values shorter than 4 characters are not masked.

Because the lookup happens on the worker, an `inherit` variable has to be set where the worker runs — in `.boboddy/.env` or the worker's environment — not in `devcontainer.json`.

### Missing required variables

If a required `inherit` variable (not `optional`, no `default`) is undefined on the worker, the step fails during the preflight, before the workspace is cloned or any container starts. The failure message lists **all** the missing names at once, each as `NAME` or `FROM (for NAME)` when `from` renames it, and never any values:

```
Step declares required environment variables that are not set on the worker: WAREHOUSE_TOKEN, STAGING_DB_PASSWORD (for DB_PASSWORD). Set them in .boboddy/.env or the worker's environment, or mark them optional.
```

Set the variables, or mark them `optional` or give them a `default`, and re-run. `inherit` also cannot read `BOBODDY_*` variables; such a definition is rejected when you push, by the server, and by the worker.

### Dry runs

`boboddy work --dry-run --step-id <id>` (or `--pipeline-id <id>`) resolves and injects the step's env into the rehearsal environment, so a missing variable shows up as a launch error in the dry-run report. A dry run has no run input, so `{{input.…}}` templates render as empty strings. With `--global-only` there is no step, hence no step env.

## Environment requirements

- **Docker** must be running and accessible to the worker process — required for `Runtime.devcontainer()` steps. `Runtime.host()` steps do not use Docker.
- **AI provider credentials** must be available. Boboddy ships and launches its own pinned OpenCode runtime, so you do not need OpenCode installed — but it reads your provider credentials from `~/.config/opencode/` or from env vars such as `ANTHROPIC_API_KEY`. See [opencode.ai/docs](https://opencode.ai/docs) for provider setup.
- Your repo must have a `.devcontainer/devcontainer.json` (or the config the step selects) by the time a `Runtime.devcontainer()` step runs. `boboddy init` only reports a missing one; the [pipeline designer](/boboddy/reference/cli/#boboddy-pipelines-design-projectid) authors it during a design session, and this worker run is what first builds it. See [Setting up a Dev Container](/boboddy/guides/devcontainer/) to write one by hand.
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

Workers use credentials stored in `~/.boboddy/auth.jsonc`. If running in CI, set the `BOBODDY_BASE_URL` environment variable and ensure credentials are available (e.g., via a secret injected at `~/.boboddy/auth.jsonc`).
