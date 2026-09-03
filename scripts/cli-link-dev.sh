#!/usr/bin/env bash
set -e

# Run pack:local, tee all output to stderr so it's visible in the terminal,
# and capture the last stdout line (the artifact path printed by the script).
ARTIFACT_PATH=$(cd packages/sdks/js && bun run pack:local | tee /dev/stderr | tail -1)

bun run --filter @boboddy/opencode-plugin build
BOBODDY_SDK_ARTIFACT_PATH="$ARTIFACT_PATH" bun run --filter @boboddy/cli build:dev
# Link as "boboddy-dev" (not "boboddy") so this doesn't clobber a real boboddy
# CLI install on the same machine.
BOBODDY_CLI_LINK_NAME="boboddy-dev" bun run --filter @boboddy/cli link
