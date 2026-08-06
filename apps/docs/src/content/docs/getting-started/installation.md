---
title: Installation
description: Install the Boboddy CLI and SDK
---

## Requirements

To run the [Quickstart](/boboddy/getting-started/quickstart/) Stage 1
(no-Docker) flow, you need:

- **Node.js** 18+ or **Bun** 1.3+ (or Bun/pnpm/yarn — any one package manager, to
  install dependencies into `.boboddy/pipeline-builder/`)
- **An AI provider configured for OpenCode** — both `boboddy pipelines design`
  and `boboddy work` run a Boboddy-managed OpenCode runtime, but they read *your*
  provider credentials. Configure a provider at
  [opencode.ai/docs](https://opencode.ai/docs), or export a key such as
  `ANTHROPIC_API_KEY`.

You do **not** need OpenCode installed. Boboddy downloads and pins its own
runtime the first time you run `boboddy pipelines design` — a one-time ~100 MB
download.

To run steps in **`workspace` mode** (agents that clone and work inside your
repository), you additionally need:

- **Docker** — used to build the per-execution dev container.
- **A `.devcontainer/devcontainer.json`** in your project root. You do not have to
  write it yourself: a design session authors one when it is missing. See
  [Setting up a Dev Container](/boboddy/guides/devcontainer/) to write one by hand.

> Steps in **`no_workspace` mode** (like the ones in the starter pipeline) run
> directly on the host and need neither Docker nor a dev container — that's what
> makes the Quickstart's first stage container-free. See
> [Execution mode](/boboddy/guides/steps/#execution-mode).

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

### Platform binaries

The npm package ships pre-compiled binaries for:

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `boboddy-darwin-arm64` |
| macOS (Intel) | `boboddy-darwin-x64` |
| Linux x64 | `boboddy-linux-x64` |
| Linux ARM64 | `boboddy-linux-arm64` |
| Windows x64 | `boboddy-windows-x64.exe` |

The wrapper at `bin/boboddy` detects your platform and delegates to the correct binary automatically.

## Install the SDK

Add the TypeScript SDK to your project:

```bash
npm install @boboddy/sdk
# or
bun add @boboddy/sdk
```

The SDK provides `defineStep`, the `pipeline()` builder, and the auto-generated API client for programmatic use.

## Authenticate

After installing the CLI, log in with your Boboddy account:

```bash
boboddy auth login
```

This opens a browser-based device flow. Your credentials are saved to `~/.boboddy.json`.

```bash
boboddy auth whoami   # confirm you're logged in
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BOBODDY_BASE_URL` | API server URL | `https://app.boboddy.dev` |

You can also pass `--base-url <url>` to any command or use `--env-file <path>` to load an alternate `.env` file.

## Next steps

Head to [Quickstart](/boboddy/getting-started/quickstart/) to initialize your first project.
