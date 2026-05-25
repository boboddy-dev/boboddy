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
3. Writes `.boboddy/boboddy.jsonc` with the `projectId`
4. Generates `.devcontainer/devcontainer.json`
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
| `<pipeline-key>.ts` | One `definePipeline()` export per pipeline |

After pulling, run `npm install` or `bun install` inside `.boboddy/pipeline-builder/` to install dependencies.

### `boboddy pipelines push [projectId]`

Push step and pipeline definitions from `.boboddy/pipeline-builder/` to the server. Both `steps.ts` and all pipeline files are read; steps are pushed first, then pipelines.

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

| Flag | Default | Description |
|------|---------|-------------|
| `--once` | `false` | Poll once and exit |
| `--concurrency <n>` | `3` | Max parallel jobs |
| `--batch-size <n>` | `5` | Max jobs claimed per poll |
| `--lease-duration-seconds <n>` | `60` | Seconds before the server reclaims an uncompleted job |
| `--poll-interval-ms <n>` | `5000` | Milliseconds between poll cycles |
| `--worker-id <id>` | auto | Override the worker ID sent to the server |
| `--work-item-id <id>` | — | Execute a specific work item and exit |
| `--preserve-runtime-on-complete` | `false` | Keep Docker containers after job completion |

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

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error (check stderr / log output) |
