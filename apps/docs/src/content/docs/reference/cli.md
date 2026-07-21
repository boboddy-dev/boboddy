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
4. Requires an existing `.devcontainer/devcontainer.json` (init errors if one is missing — it does not create one)
5. Analyzes the repo and recommends pipelines

```bash
boboddy init
```

---

## `boboddy pipelines`

Manage pipeline and step definitions. All step and pipeline authoring lives inside `.boboddy/pipeline-builder/`.

### `boboddy pipelines init`

Scaffold `.boboddy/pipeline-builder/` with a starter `package.json`, `tsconfig.json`, and example step and pipeline files. Use this for brand-new projects that have nothing on the server yet.

```bash
boboddy pipelines init
```

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
| `.gitignore` | Ignores `node_modules` (only on first pull) |
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
