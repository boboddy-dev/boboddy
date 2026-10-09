# Contributing to the boboddy CLI

`apps/cli` is the Bun + TypeScript source of `@boboddy/cli`, compiled to
standalone binaries for distribution. The user-facing README (what npm shows)
is `README.md`; everything for working on the CLI itself is here. User docs
live in `apps/docs` and are published at
<https://boboddy-dev.github.io/boboddy/>.

## Project shape

```txt
apps/cli/
  src/
    index.ts              entry point
    cli.ts                command tree and top-level runner
    commands/             one module per top-level command (init, pipelines, work, …)
    lib/                  shared CLI logic: reporters, design session, preflight, …
    auth/                 browser helpers for sign-in
    templates/            assets embedded in the binary (design agent prompt, push script)
  script/
    build.ts              compiles the binaries in targets.ts
    targets.ts            single source of truth for platform targets
    publish.ts            publishes the npm packages
    link.ts               links a build onto your PATH
  bin/
    boboddy               npm bin wrapper
    postinstall.js        install-time integrity check
  test/                   source-level tests
  compiled-binary-tests/  tests that run against the compiled binary
```

## Prerequisites

- Bun `1.4.0` or newer (the root `package.json`'s `packageManager`)

## Local development

Install dependencies from the workspace root:

```sh
bun install
```

Run the CLI directly from source:

```sh
bun run apps/cli/src/index.ts hello
bun run apps/cli/src/index.ts work 01966a2c-9494-7db5-aa46-0f8f5cbbe001
bun run apps/cli/src/index.ts auth status
```

The CLI targets `https://app.boboddy.dev` by default. Point it at a local
server with `--base-url` or the `BOBODDY_BASE_URL` environment variable.
Credentials are stored in `~/.boboddy/auth.jsonc`.

`BOBODDY_TELEMETRY_DEBUG=1` prints every telemetry payload to stderr;
`BOBODDY_TELEMETRY_DISABLED=1` turns reporting off for one invocation.

## Type checking

```sh
bun run --filter @boboddy/cli typecheck
```

## Tests

```sh
bun run --filter @boboddy/cli test
```

The tests spawn the CLI as a subprocess, so they do not require a global
install. The `compiled-binary-tests/` suite runs against the built binaries.

## Build binaries

```sh
bun run --filter @boboddy/cli build
```

This creates standalone binaries in `apps/cli/dist/` for:

- `boboddy-darwin-arm64`
- `boboddy-darwin-x64`
- `boboddy-linux-x64`
- `boboddy-linux-arm64`
- `boboddy-windows-x64.exe`

## npm bin wrapper

The package publishes the `boboddy` executable through `bin/boboddy`.

- The wrapper detects the current platform and architecture.
- It runs the matching compiled binary when available.
- It prints a clear error when the current platform is unsupported or the
  expected binary is missing.

After building, run the wrapper locally:

```sh
./bin/boboddy hello Connor
./bin/boboddy auth status
```

## Releasing

`bun run --filter @boboddy/cli publish:package` (`script/publish.ts`)
publishes one `@boboddy/cli-<platform>-<arch>` package per target, then the
thin `@boboddy/cli` package that depends on them. The main package ships only
`README.md`, `bin/`, and the bundled devcontainer CLI; this file stays in the
repo. See the module doc in `script/publish.ts` for why the CLI is split this
way.

The compiled files in `apps/cli/dist/` can also be uploaded as GitHub Release
assets for consumers who want a platform binary without npm.
