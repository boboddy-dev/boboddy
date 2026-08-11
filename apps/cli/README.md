# boboddy CLI

`boboddy` is a Bun + TypeScript CLI workspace with a modular command layout and compiled binary distribution support.

## Project Shape

```txt
apps/cli/
  src/
    index.ts
    commands/
      hello.ts
  script/
    build.ts
  bin/
    boboddy
  test/
    cli.test.ts
  package.json
  tsconfig.json
  README.md
```

## Prerequisites

- Bun `1.2.9` or newer

## Local Development

Install dependencies from the workspace root:

```sh
bun install
```

Run the CLI directly from source:

```sh
bun run apps/cli/src/index.ts hello
bun run apps/cli/src/index.ts hello Connor
bun run apps/cli/src/index.ts work 01966a2c-9494-7db5-aa46-0f8f5cbbe001
bun run apps/cli/src/index.ts auth status
```

Or from the package directory:

```sh
cd apps/cli
bun run src/index.ts hello Connor
bun run src/index.ts work 01966a2c-9494-7db5-aa46-0f8f5cbbe001
```

## Type Checking

```sh
bun run --filter @boboddy/cli typecheck
```

## Tests

```sh
bun run --filter @boboddy/cli test
```

The tests spawn the CLI as a subprocess, so they do not require a global install.

## Build Binaries

```sh
bun run --filter @boboddy/cli build
```

This creates standalone binaries in `apps/cli/dist/` for:

- `boboddy-darwin-arm64`
- `boboddy-darwin-x64`
- `boboddy-linux-x64`
- `boboddy-linux-arm64`
- `boboddy-windows-x64.exe`

## npm Bin Wrapper

The package publishes the `boboddy` executable through `bin/boboddy`.

- The wrapper detects the current platform and architecture.
- It runs the matching compiled binary from `dist/` when available.
- It prints a clear error when the current platform is unsupported or the expected binary is missing.

After building, run the wrapper locally:

```sh
./bin/boboddy hello Connor
./bin/boboddy auth login
```

## Authentication

Authenticate the CLI through the browser-based Better Auth device flow:

```sh
boboddy auth login
boboddy auth status
boboddy auth whoami
boboddy auth logout
```

By default the CLI targets `http://127.0.0.1:3000`. Override that with
`--base-url` or the `BOBODDY_BASE_URL` environment variable.

Authenticated CLI credentials are stored in `~/.boboddy.json`.

## Observability

The CLI reports a small set of onboarding milestones (init started,
requirements verified, signed in, project linked, designer launched, dry run
passed, pipeline pushed, run queued) directly to PostHog. Each event is keyed
to a random anonymous id persisted in `~/.boboddy.json` until you sign in, at
which point later events switch to your account id. `accessToken`, `email`,
and `name` are never sent as event data.

```sh
boboddy telemetry status    # is it enabled?
boboddy telemetry disable   # opt out, persists across invocations
boboddy telemetry enable    # opt back in
```

`BOBODDY_TELEMETRY_DISABLED=1` opts out for a single invocation without
touching `~/.boboddy.json`. `BOBODDY_TELEMETRY_DEBUG=1` prints every payload
to stderr in addition to sending it. See the
[Observability docs](https://boboddy-dev.github.io/boboddy/reference/observability/)
for the full list of what's collected.

## npm-Style Installation

When this workspace is published as a package, the `bin` field maps the `boboddy` command to `./bin/boboddy`.

Typical install and usage shape:

```sh
npm install -g <published-package-name>
boboddy hello Connor
```

## Future GitHub Releases

For GitHub Releases, upload the compiled files from `apps/cli/dist/` as release assets. Consumers can then download the platform-specific binary directly without installing through npm.
