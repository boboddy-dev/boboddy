import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { reporterLines } from "./utils";

/**
 * `boboddy telemetry status`, driven in-process through `run()` so the
 * baked-key case can be covered by mocking `build-constants` (a source run
 * never has a baked key). The persisted opt-out and the PostHog client are
 * mocked too, so nothing reads the real `~/.boboddy/config.jsonc` or touches
 * the network.
 *
 * Plain `test()`: every case swaps `process.stdout`/`process.stderr` writers
 * and `process.env`, which are process-wide.
 */

void mock.module("@boboddy/observability/analytics/server", () => ({
  init: () => false,
  isInitialized: () => false,
  capture: () => undefined,
  identify: () => undefined,
  alias: () => undefined,
  flush: () => Promise.resolve(),
}));

let fakeTelemetryDisabled = false;
const realWorker = await import("@boboddy/worker");
void mock.module("@boboddy/worker", () => ({
  ...realWorker,
  isTelemetryDisabled: () => fakeTelemetryDisabled,
}));

let fakeBaked: { key?: string; host?: string } = {};
void mock.module("../src/lib/build-constants", () => ({
  bakedTelemetryConfig: () => fakeBaked,
}));

const { run } = await import("../src/cli");
const {
  KEY_SOURCE_BAKED_MESSAGE,
  KEY_SOURCE_ENV_MESSAGE,
  KEY_SOURCE_NONE_MESSAGE,
} = await import("../src/commands/telemetry");
const { version: CLI_VERSION } = await import("../package.json");

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

/** Reporter lines on stderr without the plain reporter's `· ` info glyph. */
function infoLines(stderr: string): string[] {
  return reporterLines(stderr).map((line) => line.replace(/^· /u, ""));
}

async function runStatus(
  extraArgs: readonly string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    },
  );
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    },
  );
  try {
    const exitCode = await run(["telemetry", "status", ...extraArgs]);
    return { exitCode, stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

beforeEach(() => {
  resetEnv();
  fakeTelemetryDisabled = false;
  fakeBaked = {};
  // Empty, not deleted: `run()` loads `.env` without overriding, so an
  // existing (even empty) value keeps a developer's real key out of the test.
  process.env["POSTHOG_CLI_KEY"] = "";
  delete process.env["BOBODDY_TELEMETRY_DISABLED"];
});

afterEach(() => {
  resetEnv();
});

describe("boboddy telemetry status", () => {
  test("reports a baked key", async () => {
    fakeBaked = { key: "phc_baked_secret" };
    const result = await runStatus();
    expect(result.exitCode).toBe(0);
    expect(infoLines(result.stderr)).toEqual([
      "Telemetry is enabled.",
      KEY_SOURCE_BAKED_MESSAGE,
    ]);
    expect(result.stderr).not.toContain("phc_baked_secret");
  });

  test("reports the env-var override, even over a baked key", async () => {
    fakeBaked = { key: "phc_baked_secret" };
    process.env["POSTHOG_CLI_KEY"] = "phc_env_secret";
    const result = await runStatus();
    expect(infoLines(result.stderr)).toEqual([
      "Telemetry is enabled.",
      KEY_SOURCE_ENV_MESSAGE,
    ]);
    expect(result.stderr).not.toContain("phc_env_secret");
  });

  test("reports a build with no key", async () => {
    const result = await runStatus();
    expect(infoLines(result.stderr)).toEqual([
      "Telemetry is enabled.",
      KEY_SOURCE_NONE_MESSAGE,
    ]);
  });

  test("reports the persisted opt-out alongside the key source", async () => {
    fakeTelemetryDisabled = true;
    fakeBaked = { key: "phc_baked_secret" };
    const result = await runStatus();
    expect(infoLines(result.stderr)).toEqual([
      "Telemetry is disabled.",
      KEY_SOURCE_BAKED_MESSAGE,
    ]);
  });

  test("reports the BOBODDY_TELEMETRY_DISABLED=1 opt-out", async () => {
    process.env["BOBODDY_TELEMETRY_DISABLED"] = "1";
    const result = await runStatus();
    expect(result.exitCode).toBe(0);
    expect(infoLines(result.stderr)).toEqual([
      "Telemetry is disabled for this invocation via BOBODDY_TELEMETRY_DISABLED=1.",
      KEY_SOURCE_NONE_MESSAGE,
    ]);
  });

  test("human output never goes to stdout", async () => {
    const result = await runStatus();
    expect(result.stdout).toBe("");
  });
});

describe("boboddy telemetry status --json", () => {
  test("writes exactly one JSON line to stdout and nothing to stderr", async () => {
    fakeBaked = { key: "phc_baked_secret" };
    const result = await runStatus(["--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      enabled: true,
      keySource: "baked",
      version: CLI_VERSION,
    });
    expect(result.stdout).not.toContain("phc_baked_secret");
  });

  test("reports env and none key sources", async () => {
    process.env["POSTHOG_CLI_KEY"] = "phc_env_secret";
    const env = await runStatus(["--json"]);
    expect(JSON.parse(env.stdout)).toMatchObject({ keySource: "env" });
    expect(env.stdout).not.toContain("phc_env_secret");

    process.env["POSTHOG_CLI_KEY"] = "";
    const none = await runStatus(["--json"]);
    expect(JSON.parse(none.stdout)).toMatchObject({ keySource: "none" });
  });

  test("reports enabled: false under BOBODDY_TELEMETRY_DISABLED=1", async () => {
    process.env["BOBODDY_TELEMETRY_DISABLED"] = "1";
    fakeBaked = { key: "phc_baked_secret" };
    const result = await runStatus(["--json"]);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      enabled: false,
      keySource: "baked",
      version: CLI_VERSION,
    });
  });

  test("reports enabled: false under the persisted opt-out", async () => {
    fakeTelemetryDisabled = true;
    const result = await runStatus(["--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ enabled: false });
  });
});
