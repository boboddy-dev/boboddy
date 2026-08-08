---
title: CLI Reference
description: Complete reference for all boboddy CLI commands and flags
---

## Global flags

These flags apply to every command:

| Flag | Description |
|------|-------------|
| `--env-file <path>` | Load environment variables from an alternate `.env` file |
| `--base-url <url>` | Override the API server URL (default: `https://app.boboddy.dev`, also set via `BOBODDY_BASE_URL`) |
| `--help` | Show help for the current command |
| `--version` | Print the CLI version |

---

## `boboddy auth`

Manage authentication credentials.

### `boboddy auth login`

Start a device-flow browser login. Opens your browser; credentials are saved to `~/.boboddy.json` on completion.

```bash
boboddy auth login
```

### `boboddy auth logout`

Remove stored credentials.

```bash
boboddy auth logout
```

### `boboddy auth status`

Show whether you are currently authenticated.

```bash
boboddy auth status
```

### `boboddy auth whoami`

Print the email address of the authenticated user.

```bash
boboddy auth whoami
```

---

## `boboddy init`

Interactive project setup. Runs in sequence:

1. Authenticates (device flow if not logged in)
2. Creates or selects a project
3. Writes `.boboddy/boboddy.jsonc` with the `projectId` (you can also add an optional `branchPrefix` — see [Work branches](/boboddy/guides/workers/#work-branches))
4. Checks for a `.devcontainer/devcontainer.json` and reports what it finds. A missing one is a **notice, not an error** — `init` does not write one, but it does not stop either: the design session authors it (see [`pipelines design`](#boboddy-pipelines-design-projectid))
5. Offers to launch [`boboddy pipelines design`](#boboddy-pipelines-design-projectid) straight away

```bash
boboddy init
```

`init` does not create any pipeline. All authoring happens in `boboddy pipelines design`. Re-running `init` on an already-configured project is safe: it re-checks the dev container and offers the handoff again.

`init` does not analyze the repo. The design agent does that itself, by reading the repository at the start of a session.

---

## `boboddy pipelines`

Manage pipeline and step definitions. All step and pipeline authoring lives inside `.boboddy/pipeline-builder/`.

### `boboddy pipelines design [projectId]`

Design pipelines interactively with an AI agent, then push them. This is the recommended way to author pipelines: it scaffolds whatever is missing, interviews you about your project, writes the definitions, typechecks them, and pushes.

```bash
boboddy pipelines design
boboddy pipelines design <projectId>
```

| Flag | Description |
|------|-------------|
| `--base-url <url>` | Override the API server URL |
| `--work-item-id <id>` | Design around this specific work item ID instead of picking from the project's recent items. Wins outright and skips the picker entirely — use it for an item older than the picker's recent window, or any time you already have the id. An id that does not resolve (wrong id, or belongs to a different project) is a hard stop, not a silent fall-through to the picker |

**Preflight.** Every precondition is self-healing except the last one:

| Check | If missing |
|-------|------------|
| Boboddy session | Runs the device-flow login inline |
| Project ID | Uses the positional argument, else `.boboddy/boboddy.jsonc`, else matches this repo's `origin` remote to a project on the server (creating it when absent) and writes `.boboddy/boboddy.jsonc`. Only prompts when the repo has no `origin` remote |
| A work item to design around | With `--work-item-id`, loads that item directly and skips the picker. Otherwise shows a picker of the project's most recent ingested items, whose last option is always *paste or describe a different one*. That option takes a ticket URL or a plain description and creates the item server-side (platform `boboddy`). Every session designs around a real work item |
| `.boboddy/pipeline-builder/` | Scaffolds it (requires a `.git` or `.boboddy` directory in the current directory) |
| Dependencies | Installs them with the package manager matching the directory's lockfile, else `bun` or `npm` from your `PATH` |
| AI runtime | Downloads the pinned OpenCode runtime once (~100 MB, with progress) |
| AI provider credentials | **Hard stop.** Prints the `auth login` command for the provisioned runtime and exits |

You do **not** need OpenCode installed — Boboddy downloads and pins its own runtime. You do need your own provider credentials (an OpenCode `auth login`, or an env var such as `ANTHROPIC_API_KEY`). The injected config deep-merges over your global `~/.config/opencode/opencode.json[c]` and deliberately omits `model`, so your configured model and provider are used.

**The session.** The command launches the OpenCode TUI in `.boboddy/pipeline-builder/` with an injected `pipeline-designer` agent, seeded with the work item you chose. The agent reads what's already there and orients itself in the repository, then opens on the goal: what should come out the other end when a ticket like this one arrives? Every question after that is asked through that item — what it would take to work it, what the execution environment can reach, what must never be touched — before it proposes 2–3 ranked pipeline archetypes filtered by what's actually reachable. It builds the one you pick plus `default-pipeline-assignment.ts`, typechecks, and runs `boboddy pipelines push`.

**Edit sessions.** When definitions already exist, the agent must state a change-size verdict and get your confirmation before it edits a file: **tweak** an existing pipeline, add a **route** in `default-pipeline-assignment.ts`, or create a **new pipeline**. It prefers them in that order and escalates only when the cheaper change can't express the difference, so a second pipeline that duplicates most of an existing one's steps comes back as a tweak or a route instead. One confirmed change per session is the norm, not a limit.

**The devcontainer.** If the repository has no `.devcontainer/devcontainer.json`, the agent writes one mid-session, before it authors any pipeline file, using the orientation it already performed — runtime and version pins, the package manager that owns the lockfile, the services in `docker-compose.yml`, the install lines in CI. It is **write-only**: no image is built during the session, and your first pipeline run is what verifies it. The agent says as much when it hands the config over.

**Permissions.** A design session is supervised — you are watching the TUI — so shell commands run unattended. The agent needs your project's own toolchain (its test runner, its typecheck script, its linter), and no allowlist can enumerate that in advance. One command is the exception: `boboddy pipelines push` always prompts, however it is invoked, because that confirmation is the moment anything reaches the server.

Writing is scoped, and that is what contains the session. Reading and searching are unattended repo-wide so the agent can orient itself, but it may only *write* to `.boboddy/pipeline-builder/` and `.devcontainer/`. Every other path — `package.json`, your source, CI config — asks first. Network access and subagents ask too.

**The run offer.** When the session exits cleanly, `design` closes its own loop: it asks *Run your new pipeline on “&lt;work item title&gt;” now?*, and on yes it queues a run of the assigned pipeline against that work item and runs the worker in the same terminal. There is no flag to learn.

| Situation | What happens |
|-----------|--------------|
| Devcontainer present, pipeline assigned | The confirm appears; accepting queues the run and runs the worker here |
| You decline | Prints `boboddy work <projectId> --work-item-id <id>` for later, and notes that nothing is queued yet — start a run from the work item in the dashboard and that command picks it up |
| No `.devcontainer/devcontainer.json` | No offer — steps execute inside your devcontainer, so it prints the devcontainer guidance plus that same command |
| No pipeline assigned to the project | No offer — the session never got as far as pushing one |
| The session did not exit cleanly | No offer. A non-zero designer exit code still passes through |

Before the worker starts, the offer states where a failure goes: back to `boboddy pipelines design`, to tell the agent what happened. That covers the failures the worker absorbs into its polling loop — a failing step, or a devcontainer that won't build — which do not stop the worker and so cannot be reported after the fact. The edit loop is the repair loop.

The worker keeps polling until you stop it, because later steps are only queued as earlier ones advance.

Re-run `design` any time. It reads your existing definitions and iterates instead of starting over, so the same command covers first-time setup and ongoing changes — a new session, a different work item.

An interactive terminal is required — the command errors out under a pipe, redirect, or CI runner.

### `boboddy pipelines init`

Scaffold `.boboddy/pipeline-builder/` with a starter `package.json`, `tsconfig.json`, and example step and pipeline files, then edit them by hand. Must be run from the root of a git repository. Use `boboddy pipelines design` unless you specifically want to author everything yourself.

```bash
boboddy pipelines init
cd .boboddy/pipeline-builder && npm install   # or bun/pnpm/yarn install
```

The scaffolded `package.json` includes a `typecheck` script (`tsc -p tsconfig.json`), so `npm run typecheck` in that directory validates your definitions before you push.

The scaffolded `.gitignore` ignores only `node_modules/`, lockfiles, and `push.ts`. **Your pipeline and step definitions are source code — commit and review them.** Lockfiles are deliberately *not* committed: `boboddy pipelines push` picks its runtime from whichever lockfile it finds in that directory, so committing one would force every teammate onto the same package manager.

### `boboddy pipelines pull [projectId]`

Fetch pipeline and step definitions from the server and write them into `.boboddy/pipeline-builder/` as editable TypeScript files. If the directory already contains files you will be prompted before they are overwritten.

```bash
boboddy pipelines pull
boboddy pipelines pull <projectId>
```

| Flag | Description |
|------|-------------|
| `--base-url <url>` | Override the API server URL |

**What gets written:**

| File | Description |
|------|-------------|
| `package.json` | Declares `@boboddy/sdk` and `zod` dependencies (only on first pull) |
| `tsconfig.json` | TypeScript config scoped to the pipeline-builder package (only on first pull) |
| `.gitignore` | Ignores `node_modules/`, lockfiles, and `push.ts` (only on first pull) |
| `steps.ts` | One `defineStep()` export per step definition (latest version of each key) |
| `<pipeline-key>.ts` | One pipeline export per pipeline (uses the fluent `pipeline()` builder) |
| `default-pipeline-assignment.ts` | Project routing policy (written if configured on the server; removed if not) |

After pulling, run `npm install` or `bun install` inside `.boboddy/pipeline-builder/` to install dependencies.

### `boboddy pipelines push [projectId]`

Push step and pipeline definitions from `.boboddy/pipeline-builder/` to the server. Steps are pushed first, then pipelines. If `default-pipeline-assignment.ts` is present it is synced to the server last. Absent files are ignored; they do not clear server configuration.

```bash
boboddy pipelines push
boboddy pipelines push <projectId>
```

| Flag | Description |
|------|-------------|
| `--base-url <url>` | Override the API server URL |

---

## `boboddy work [projectId]`

Run a worker that polls for and executes step jobs.

```bash
boboddy work
boboddy work <projectId>
```

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--once` | — | `false` | Poll once and wait for any claimed jobs to finish |
| `--concurrency <n>` | `-c` | `1` | Max concurrently active jobs (env: `BOBODDY_WORK_CONCURRENCY`) |
| `--batch-size <n>` | `-b` | value of `--concurrency` | Max step executions claimed per poll |
| `--lease-duration-seconds <n>` | `-l` | `30` | Seconds the claim lease lasts (env: `BOBODDY_WORK_LEASE_DURATION_SECONDS`) |
| `--poll-interval-ms <n>` | `-p` | `5000` | Milliseconds between poll cycles (env: `BOBODDY_WORK_POLL_INTERVAL_MS`) |
| `--worker-id <id>` | `-w` | auto | Worker identifier used while claiming steps |
| `--work-item-id <id>` | — | — | Only process step executions for this work item ID |
| `--source-branch <branch>` | — | your current local branch | Override the branch checked out for the first step of this run. Defaults to your current local branch, which must exist and be in exact sync with `origin` (push it first if it isn't) |
| `--preserve-runtime-on-complete` | `-k` | `false` | Keep runtime containers and workspace after step completion |

---

## `boboddy runtime`

Utilities for managing the local execution environment.

### `boboddy runtime cleanup-networks`

Remove unused Docker networks created by prior worker runs.

```bash
boboddy runtime cleanup-networks
boboddy runtime cleanup-networks --verbose
```

| Flag | Description |
|------|-------------|
| `--verbose` | Print names of networks as they are removed |

---

## `boboddy hello [name]`

Print a greeting. Primarily used to verify the CLI is installed correctly.

```bash
boboddy hello          # Hello, world!
boboddy hello Alice    # Hello, Alice!
```

---

## `boboddy report-bug`

File a bug report against the CLI. By default it opens a prefilled GitHub issue in your browser.

```bash
boboddy report-bug
boboddy report-bug --title "..." --description "..." --no-browser
```

| Flag | Default | Description |
|------|---------|-------------|
| `--title <text>` | — | Short summary of the bug |
| `--description <text>` | — | Detailed description |
| `--browser` / `--no-browser` | `true` | Open the prefilled issue in a browser; `--no-browser` prints the URL only |

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error (check stderr / log output) |
