import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type {
  InstalledAiTool,
  OpencodeProviderCredentialCheck,
} from "@boboddy/worker";
import { CliError } from "../src/lib/cli-error";
import {
  buildConnectGuidance,
  CONNECT_DID_NOT_COMPLETE_MESSAGE,
  CONNECT_GUIDANCE_HEADER_LINES,
  CONNECT_HANDOFF_LINE,
  CONNECT_NO_TOOL_LINE,
  CONNECT_TOOL_LINES,
  ensureProviderConnected,
  type ProviderConnectPorts,
} from "../src/lib/design-provider-connect";
import { createReporterRecorder, type RecordedReport } from "./utils";

/**
 * The design preflight's provider-connect step. Every port is a spy — no
 * network, no filesystem, no real subprocess. The reporter is a recorder
 * sharing one ordered log with the ports, because the order is the contract:
 * the clack block closes before the login owns the tty and reopens after.
 */

const LAUNCHER = "/home/u/.boboddy/runtimes/opencode/1.18.11/launch.sh";
const OK: OpencodeProviderCredentialCheck = {
  ok: true,
  providers: ["anthropic"],
};
const MISSING: OpencodeProviderCredentialCheck = {
  ok: false,
  remediation: "opencode auth login",
};

function setup(overrides: {
  checks?: readonly OpencodeProviderCredentialCheck[];
  detected?: InstalledAiTool[];
  runAuthLogin?: () => Promise<void>;
}) {
  const recorder = createReporterRecorder();
  const log = recorder.calls;
  const checks = [...(overrides.checks ?? [OK])];
  const ports: ProviderConnectPorts = {
    checkCredentials: (launcherPath) => {
      log.push({ method: "port:checkCredentials", message: launcherPath });
      return Promise.resolve(checks.shift() ?? MISSING);
    },
    detectInstalledTools: () => {
      log.push({ method: "port:detectInstalledTools", message: "" });
      return Promise.resolve(overrides.detected ?? []);
    },
    runAuthLogin: (launcherPath) => {
      log.push({ method: "port:runAuthLogin", message: launcherPath });
      return overrides.runAuthLogin?.() ?? Promise.resolve();
    },
  };
  const run = () =>
    ensureProviderConnected({
      launcherPath: LAUNCHER,
      reporter: recorder.reporter,
      ports,
    });
  return { run, log };
}

function methods(log: readonly RecordedReport[]): string[] {
  return log.map((entry) => entry.method);
}

function infoLines(log: readonly RecordedReport[]): string[] {
  return log
    .filter((entry) => entry.method === "info")
    .map((entry) => entry.message);
}

async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Expected an Error, received ${String(error)}`);
  }
  throw new Error("Expected a rejection, but it resolved.");
}

/**
 * Captures are observed through telemetry's own debug print with telemetry
 * disabled — nothing is sent and no anonymous id is persisted, so no
 * `mock.module` of `telemetry.ts` (process-wide in bun) is needed.
 */
const TELEMETRY_ENV = ["BOBODDY_TELEMETRY_DISABLED", "BOBODDY_TELEMETRY_DEBUG"];
let savedTelemetryEnv: Record<string, string | undefined> = {};
let consoleErrorSpy: ReturnType<typeof spyOn<Console, "error">>;

beforeEach(() => {
  savedTelemetryEnv = Object.fromEntries(
    TELEMETRY_ENV.map((key) => [key, process.env[key]]),
  );
  process.env["BOBODDY_TELEMETRY_DISABLED"] = "1";
  process.env["BOBODDY_TELEMETRY_DEBUG"] = "1";
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  for (const [key, value] of Object.entries(savedTelemetryEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

type CapturedEvent = { event: string; properties?: Record<string, unknown> };

function capturedEvents(): CapturedEvent[] {
  return consoleErrorSpy.mock.calls
    .filter((args) => args[0] === "[boboddy telemetry]")
    .map((args) => JSON.parse(String(args[1])) as CapturedEvent)
    .map(({ event, properties }) => ({ event, properties }));
}

describe("ensureProviderConnected", () => {
  test("a credential already present skips detection and login", async () => {
    const { run, log } = setup({ checks: [OK] });

    const result = await run();

    expect(result.providers).toEqual(["anthropic"]);
    expect(methods(log)).toEqual(["port:checkCredentials", "success"]);
    expect(log[0]?.message).toBe(LAUNCHER);
    expect(log[1]?.message).toBe("AI provider ready (anthropic)");
    expect(capturedEvents()).toEqual([]);
  });

  test("no credential: guides, closes the block, logs in, reopens, rechecks", async () => {
    const { run, log } = setup({
      checks: [MISSING, { ok: true, providers: ["openai"] }],
      detected: ["codex"],
    });

    const result = await run();

    expect(result.providers).toEqual(["openai"]);
    expect(methods(log)).toEqual([
      "port:checkCredentials",
      "port:detectInstalledTools",
      ...buildConnectGuidance(["codex"]).map(() => "info"),
      "finish",
      "port:runAuthLogin",
      "start",
      "port:checkCredentials",
      "success",
    ]);
    expect(log.find((entry) => entry.method === "finish")?.message).toBe(
      CONNECT_HANDOFF_LINE,
    );
    expect(log.find((entry) => entry.method === "start")?.message).toBe(
      "Boboddy pipeline designer",
    );
    expect(log.at(-1)?.message).toBe("AI provider ready (openai)");
    expect(capturedEvents()).toEqual([
      {
        event: "cli_provider_connect_started",
        properties: { detected: ["codex"] },
      },
      {
        event: "cli_provider_connect_completed",
        properties: { providers: ["openai"] },
      },
    ]);
  });

  test("prints one guidance line per detected tool, in a fixed order", async () => {
    const { run, log } = setup({
      checks: [MISSING, OK],
      detected: ["codex", "copilot", "claude"],
    });

    await run();

    expect(infoLines(log)).toEqual([
      ...CONNECT_GUIDANCE_HEADER_LINES,
      CONNECT_TOOL_LINES.claude,
      CONNECT_TOOL_LINES.copilot,
      CONNECT_TOOL_LINES.codex,
    ]);
  });

  test("prints the generic line only when no tool was detected", async () => {
    const { run, log } = setup({ checks: [MISSING, OK], detected: [] });

    await run();

    expect(infoLines(log)).toEqual([
      ...CONNECT_GUIDANCE_HEADER_LINES,
      CONNECT_NO_TOOL_LINE,
    ]);
    expect(buildConnectGuidance(["claude"])).not.toContain(
      CONNECT_NO_TOOL_LINE,
    );
  });

  test("throws opencode_login_failed when the recheck still finds nothing", async () => {
    const { run, log } = setup({ checks: [MISSING, MISSING] });

    const error = await expectRejection(run());

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("opencode_login_failed");
    expect(error.message).toBe(CONNECT_DID_NOT_COMPLETE_MESSAGE);
    expect(methods(log)).not.toContain("success");
    expect(capturedEvents().map((entry) => entry.event)).toEqual([
      "cli_provider_connect_started",
    ]);
  });

  test("a failing login propagates without a success line", async () => {
    const { run, log } = setup({
      checks: [MISSING, OK],
      runAuthLogin: () => Promise.reject(new Error("login exploded")),
    });

    const error = await expectRejection(run());

    expect(error.message).toBe("login exploded");
    expect(methods(log)).not.toContain("success");
    expect(methods(log)).not.toContain("start");
  });
});
