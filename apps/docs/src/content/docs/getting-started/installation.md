---
title: Installation
description: Install the Boboddy CLI
---

## Requirements

To get through [Quickstart](/boboddy/getting-started/quickstart/)'s first
pipeline run, you need:

- **Node.js** 18+ or **Bun** 1.3+ (or npm/pnpm/yarn — any one package manager, to
  install dependencies into `.boboddy/pipeline-builder/`)
- **An AI provider configured for OpenCode** — both `boboddy init` and
  `boboddy pipelines design` run a Boboddy-managed OpenCode runtime, but they
  read *your* provider credentials. See
  [Connecting providers](https://opencode.ai/docs/providers/) on the OpenCode
  docs, or just run `boboddy init` and it will walk you through signing in the
  first time it needs to.

You do **not** need OpenCode installed. Boboddy downloads and pins its own
runtime the first time it's needed — a one-time ~100 MB download.

To run steps in **`workspace` mode** (agents that clone and work inside your
repository), you additionally need:

- **Docker** — used to build the per-execution dev container.
- **A `.devcontainer/devcontainer.json`** in your project root. You do not have to
  write it yourself: a design session authors one when it is missing. See
  [Setting up a Dev Container](/boboddy/guides/devcontainer/) to write one by hand.

:::note
Steps in **`no_workspace` mode** (like the ones in the starter pipeline) run
directly on the host and need neither Docker nor a dev container — that's what
keeps a first pipeline run container-free until a step actually needs your
repository. See [Execution mode](/boboddy/guides/steps/#execution-mode).
:::

## Install the CLI

Install the `@boboddy/cli` package globally via npm. It installs the `boboddy` command:

```bash
npm i -g @boboddy/cli
```

Or with Bun:

```bash
bun add -g @boboddy/cli
```

Verify the installation:

```bash
boboddy --version
```

The npm package ships pre-compiled binaries for macOS, Linux, and Windows — see
the full platform table in the [CLI reference](/boboddy/reference/cli/#platform-binaries)
if you're troubleshooting an install.

## Next steps

`boboddy init` handles signing in — to both Boboddy and OpenCode — as part of
project setup, so there's no separate login step to run first. Head to
[Quickstart](/boboddy/getting-started/quickstart/) to run it.

Already signed in and just need the commands? See the
[CLI reference](/boboddy/reference/cli/) for `boboddy auth`, environment
variables, and every flag.
