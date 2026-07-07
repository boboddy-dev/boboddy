---
title: Installation
description: Install the Boboddy CLI and SDK
---

## Requirements

- **Node.js** 18+ or **Bun** 1.3+
- **Docker** (required for `boboddy work` to execute steps locally)
- **OpenCode** (required for `boboddy work` to run AI agents) — install and configure at [opencode.ai/docs](https://opencode.ai/docs)
- **`.devcontainer`** — a `devcontainer.json` in your project root is required for `boboddy work` to spin up execution environments. See [Setting up a Dev Container](/boboddy/guides/devcontainer/) to generate one for your project.

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
