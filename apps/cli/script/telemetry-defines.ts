import {
  BAKED_POSTHOG_CLI_HOST_DEFINE,
  BAKED_POSTHOG_CLI_KEY_DEFINE,
} from "../src/lib/build-constants";

/**
 * The `bun build` `--define` arguments that bake the CLI's write-only PostHog
 * token (and optional host) into every binary, so the onboarding funnel
 * reports from installed copies without users setting env vars. Bun only
 * honours the two-argument `--define K=V` form; the `--define:K=V` form is
 * silently ignored.
 *
 * Without `POSTHOG_CLI_KEY` the build still succeeds (local and PR-preview
 * builds), unless `BOBODDY_REQUIRE_TELEMETRY_KEY=1` — set that in release
 * pipelines so a missing secret fails loudly instead of shipping a binary
 * that silently drops every event.
 *
 * Shared by `script/build.ts` and the compiled-binary test that proves the
 * define survives `--compile`.
 */
export function resolveTelemetryDefines(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = (message) => process.stdout.write(message),
): string[] {
  const key = env["POSTHOG_CLI_KEY"] ?? "";
  const host = env["POSTHOG_CLI_HOST"] ?? "";

  if (!key) {
    if (env["BOBODDY_REQUIRE_TELEMETRY_KEY"] === "1") {
      throw new Error(
        "POSTHOG_CLI_KEY is not set but BOBODDY_REQUIRE_TELEMETRY_KEY=1. Refusing to build a release binary that cannot report telemetry.",
      );
    }
    log(
      "POSTHOG_CLI_KEY is not set; built binaries will not send CLI telemetry.\n",
    );
    return [];
  }

  const defines = [
    "--define",
    `${BAKED_POSTHOG_CLI_KEY_DEFINE}=${JSON.stringify(key)}`,
  ];
  if (host) {
    defines.push(
      "--define",
      `${BAKED_POSTHOG_CLI_HOST_DEFINE}=${JSON.stringify(host)}`,
    );
  }
  return defines;
}
