import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthProfile } from "@boboddy/worker";

/**
 * `telemetry.ts` reaches into two real modules that must not touch the
 * network or the developer's real `~/.boboddy/config.jsonc` in a test run:
 * `@boboddy/observability/analytics/server` (mocked fully, mirroring
 * `packages/observability/tests/analytics/server.test.ts`) and
 * `@boboddy/worker` (mocked partially — only the
 * three functions telemetry actually calls; everything else stays real, so
 * command modules pulled in transitively still resolve).
 *
 * Both mocks must be registered before the first import of `../src/lib
 * /telemetry`, so this file never imports it at the top level.
 */

type CaptureArgs = {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
};
type IdentifyArgs = {
  distinctId: string;
  properties?: Record<string, unknown>;
};
type AliasArgs = { userId: string; previousId: string };
type InitArgs = { key: string; host: string };

let captureCalls: CaptureArgs[] = [];
let identifyCalls: IdentifyArgs[] = [];
let aliasCalls: AliasArgs[] = [];
let initCalls: InitArgs[] = [];
let shutdownCalls: (number | undefined)[] = [];
let initialized = false;
let captureShouldThrow = false;

void mock.module("@boboddy/observability/analytics/server", () => ({
  init: (options: InitArgs) => {
    initCalls.push(options);
    initialized = Boolean(options.key && options.host);
    return initialized;
  },
  isInitialized: () => initialized,
  capture: (
    distinctId: string,
    event: string,
    properties?: Record<string, unknown>,
  ) => {
    if (captureShouldThrow) throw new Error("boom");
    captureCalls.push({ distinctId, event, properties });
  },
  identify: (distinctId: string, properties?: Record<string, unknown>) => {
    identifyCalls.push({ distinctId, properties });
  },
  alias: (userId: string, previousId: string) => {
    aliasCalls.push({ userId, previousId });
  },
  shutdown: (timeoutMs?: number) => {
    shutdownCalls.push(timeoutMs);
    initialized = false;
    return Promise.resolve();
  },
}));

let fakeAnonymousId = "anon-fixed-id";
let fakeTelemetryDisabled = false;
let fakeProfiles: Record<string, AuthProfile | null> = {};
let getOrCreateAnonymousIdCalls = 0;

const realWorker = await import("@boboddy/worker");
void mock.module("@boboddy/worker", () => ({
  ...realWorker,
  getOrCreateAnonymousId: () => {
    getOrCreateAnonymousIdCalls += 1;
    return fakeAnonymousId;
  },
  isTelemetryDisabled: () => fakeTelemetryDisabled,
  loadAuthProfile: (baseUrl: string) => fakeProfiles[baseUrl] ?? null,
}));

let fakeBaked: { key?: string; host?: string } = {};
void mock.module("../src/lib/build-constants", () => ({
  bakedTelemetryConfig: () => fakeBaked,
}));

const telemetry = await import("../src/lib/telemetry");
const { version: CLI_VERSION } = await import("../package.json");

function context(cliKeySource: "baked" | "env") {
  return {
    cli_version: CLI_VERSION,
    os: process.platform,
    arch: process.arch,
    cli_key_source: cliKeySource,
  };
}

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
  captureCalls = [];
  identifyCalls = [];
  aliasCalls = [];
  initCalls = [];
  shutdownCalls = [];
  initialized = false;
  captureShouldThrow = false;
  getOrCreateAnonymousIdCalls = 0;
  fakeAnonymousId = "anon-fixed-id";
  fakeTelemetryDisabled = false;
  fakeProfiles = {};
  fakeBaked = {};
  resetEnv();
  process.env["POSTHOG_CLI_KEY"] = "phc_test";
  process.env["POSTHOG_CLI_HOST"] = "https://t.boboddy.dev";
  delete process.env["BOBODDY_TELEMETRY_DISABLED"];
  delete process.env["BOBODDY_TELEMETRY_DEBUG"];
  telemetry.resetTelemetryStateForTests();
});

afterEach(() => {
  resetEnv();
});

describe("captureMilestone", () => {
  test("sends the event under the anonymous id before any identity is known", () => {
    telemetry.captureMilestone("cli_init_started");
    expect(captureCalls).toEqual([
      {
        distinctId: "anon-fixed-id",
        event: "cli_init_started",
        properties: context("env"),
      },
    ]);
  });

  test("forwards the caller's properties alongside the build context", () => {
    telemetry.captureMilestone("cli_project_linked", {
      linked: "new",
      via: "api",
    });
    expect(captureCalls).toEqual([
      {
        distinctId: "anon-fixed-id",
        event: "cli_project_linked",
        properties: { linked: "new", via: "api", ...context("env") },
      },
    ]);
  });

  test("is a silent no-op when POSTHOG_CLI_KEY is unset", () => {
    delete process.env["POSTHOG_CLI_KEY"];
    telemetry.captureMilestone("cli_init_started");
    expect(captureCalls).toEqual([]);
    expect(getOrCreateAnonymousIdCalls).toBe(0);
  });

  test("is a silent no-op when BOBODDY_TELEMETRY_DISABLED=1", () => {
    process.env["BOBODDY_TELEMETRY_DISABLED"] = "1";
    telemetry.captureMilestone("cli_init_started");
    expect(captureCalls).toEqual([]);
    expect(initCalls).toEqual([]);
  });

  test("is a silent no-op when the persisted opt-out flag is set", () => {
    fakeTelemetryDisabled = true;
    telemetry.captureMilestone("cli_init_started");
    expect(captureCalls).toEqual([]);
    expect(initCalls).toEqual([]);
  });

  test("never creates/persists an anonymous id when disabled via env var", () => {
    process.env["BOBODDY_TELEMETRY_DISABLED"] = "1";
    telemetry.captureMilestone("cli_init_started");
    expect(getOrCreateAnonymousIdCalls).toBe(0);
  });

  test("never creates/persists an anonymous id when disabled via the persisted flag", () => {
    fakeTelemetryDisabled = true;
    telemetry.captureMilestone("cli_init_started");
    expect(getOrCreateAnonymousIdCalls).toBe(0);
  });

  test("never throws when the underlying capture call throws", () => {
    captureShouldThrow = true;
    expect(() => {
      telemetry.captureMilestone("cli_init_started");
    }).not.toThrow();
  });
});

describe("build context", () => {
  test("every capture carries cli_version, os, arch and cli_key_source", () => {
    telemetry.captureMilestone("cli_init_started");
    telemetry.captureMilestone("cli_command_failed", {
      command: "init",
      code: "unknown",
    });
    telemetry.captureMilestone("cli_designer_launched", {
      providers: ["anthropic"],
    });
    telemetry.captureMilestone("cli_studio_opened", {
      via: "studio",
      browser_opened: false,
    });
    expect(captureCalls).toHaveLength(4);
    for (const call of captureCalls) {
      expect(call.properties).toMatchObject(context("env"));
    }
    expect(captureCalls[3]?.properties).toMatchObject({
      via: "studio",
      browser_opened: false,
    });
  });

  test("cli_key_source is baked with only a baked key", () => {
    delete process.env["POSTHOG_CLI_KEY"];
    fakeBaked = { key: "phc_baked" };
    telemetry.captureMilestone("cli_init_started");
    expect(captureCalls[0]?.properties?.["cli_key_source"]).toBe("baked");
  });

  test("cli_key_source is env when only the env var is set", () => {
    telemetry.captureMilestone("cli_init_started");
    expect(captureCalls[0]?.properties?.["cli_key_source"]).toBe("env");
  });

  test("cli_key_source is env when the env var overrides a baked key", () => {
    fakeBaked = { key: "phc_baked" };
    telemetry.captureMilestone("cli_init_started");
    expect(captureCalls[0]?.properties?.["cli_key_source"]).toBe("env");
  });

  test("a caller property named cli_version can't override the context value", () => {
    telemetry.captureMilestone("cli_init_started", {
      cli_version: "9.9.9-spoofed",
      cli_key_source: "spoofed",
    });
    expect(captureCalls[0]?.properties).toEqual(context("env"));
  });

  test("telemetryKeySource reports none, baked and env with the same precedence as the key", () => {
    delete process.env["POSTHOG_CLI_KEY"];
    expect(telemetry.telemetryKeySource()).toBe("none");
    process.env["POSTHOG_CLI_KEY"] = "";
    fakeBaked = { key: "phc_baked" };
    expect(telemetry.telemetryKeySource()).toBe("baked");
    process.env["POSTHOG_CLI_KEY"] = "phc_env";
    expect(telemetry.telemetryKeySource()).toBe("env");
  });
});

describe("key and host resolution", () => {
  test("uses the build-baked key and host when the env vars are unset", () => {
    delete process.env["POSTHOG_CLI_KEY"];
    delete process.env["POSTHOG_CLI_HOST"];
    fakeBaked = { key: "phc_baked", host: "https://baked.example.com" };
    telemetry.captureMilestone("cli_init_started");
    expect(initCalls).toEqual([
      { key: "phc_baked", host: "https://baked.example.com" },
    ]);
    expect(captureCalls).toHaveLength(1);
  });

  test("falls back to the baked key when the env var is set but empty", () => {
    process.env["POSTHOG_CLI_KEY"] = "";
    fakeBaked = { key: "phc_baked" };
    telemetry.captureMilestone("cli_init_started");
    expect(initCalls[0]?.key).toBe("phc_baked");
  });

  test("env vars override the baked key and host", () => {
    fakeBaked = { key: "phc_baked", host: "https://baked.example.com" };
    telemetry.captureMilestone("cli_init_started");
    expect(initCalls).toEqual([
      { key: "phc_test", host: "https://t.boboddy.dev" },
    ]);
  });

  test("defaults the host when neither env nor build provides one", () => {
    delete process.env["POSTHOG_CLI_HOST"];
    telemetry.captureMilestone("cli_init_started");
    expect(initCalls[0]?.host).toBe("https://us.i.posthog.com");
  });

  test("the persisted opt-out still wins over a baked key", () => {
    delete process.env["POSTHOG_CLI_KEY"];
    fakeBaked = { key: "phc_baked" };
    fakeTelemetryDisabled = true;
    telemetry.captureMilestone("cli_init_started");
    expect(initCalls).toEqual([]);
    expect(captureCalls).toEqual([]);
  });
});

describe("identity", () => {
  test("identifyAuthenticatedUser switches later events to the real user id", () => {
    telemetry.captureMilestone("cli_init_started");
    telemetry.identifyAuthenticatedUser({
      userId: "user-1",
      email: "user@example.com",
      name: "User One",
    });
    telemetry.captureMilestone("cli_auth_completed");

    expect(captureCalls.map((c) => c.distinctId)).toEqual([
      "anon-fixed-id",
      "user-1",
    ]);
  });

  test("identifyAuthenticatedUser sends email/name only via identify(), never as event properties", () => {
    telemetry.identifyAuthenticatedUser({
      userId: "user-1",
      email: "user@example.com",
      name: "User One",
    });
    expect(identifyCalls).toEqual([
      {
        distinctId: "user-1",
        properties: { email: "user@example.com", name: "User One" },
      },
    ]);
  });

  test("identifyAuthenticatedUser aliases the anonymous id into the real one", () => {
    telemetry.captureMilestone("cli_init_started"); // resolves + caches the anonymous id
    telemetry.identifyAuthenticatedUser({ userId: "user-1" });
    expect(aliasCalls).toEqual([
      { userId: "user-1", previousId: "anon-fixed-id" },
    ]);
  });

  test("does not alias when no anonymous id was ever resolved this session", () => {
    telemetry.identifyAuthenticatedUser({ userId: "user-1" });
    expect(aliasCalls).toEqual([]);
  });

  test("syncIdentityFromDisk adopts a userId already stored for this baseUrl", () => {
    fakeProfiles["https://app.example.com"] = {
      accessToken: "token",
      userId: "user-2",
      email: "user2@example.com",
    };
    telemetry.syncIdentityFromDisk("https://app.example.com");
    telemetry.captureMilestone("cli_requirements_verified");
    expect(captureCalls).toEqual([
      {
        distinctId: "user-2",
        event: "cli_requirements_verified",
        properties: context("env"),
      },
    ]);
  });

  test("syncIdentityFromDisk is a no-op when no profile is stored", () => {
    telemetry.syncIdentityFromDisk("https://app.example.com");
    telemetry.captureMilestone("cli_requirements_verified");
    expect(captureCalls[0]?.distinctId).toBe("anon-fixed-id");
  });

  test("syncIdentityFromDisk does not override an identity already resolved this process", () => {
    telemetry.identifyAuthenticatedUser({ userId: "user-1" });
    fakeProfiles["https://app.example.com"] = {
      accessToken: "token",
      userId: "user-2",
    };
    telemetry.syncIdentityFromDisk("https://app.example.com");
    telemetry.captureMilestone("cli_requirements_verified");
    expect(captureCalls[0]?.distinctId).toBe("user-1");
  });
});

describe("debug mode", () => {
  test("BOBODDY_TELEMETRY_DEBUG=1 still sends the event (alongside printing)", () => {
    process.env["BOBODDY_TELEMETRY_DEBUG"] = "1";
    telemetry.captureMilestone("cli_init_started");
    expect(captureCalls).toHaveLength(1);
  });
});

describe("shutdownTelemetry", () => {
  test("shuts the client down with the default timeout when telemetry was initialized", async () => {
    telemetry.captureMilestone("cli_init_started");
    await telemetry.shutdownTelemetry();
    expect(shutdownCalls).toEqual([1500]);
  });

  test("forwards a caller-supplied timeout", async () => {
    telemetry.captureMilestone("cli_init_started");
    await telemetry.shutdownTelemetry(5);
    expect(shutdownCalls).toEqual([5]);
  });

  test("is a no-op when telemetry was never initialized", async () => {
    await telemetry.shutdownTelemetry();
    expect(shutdownCalls).toEqual([]);
  });
});

describe("run() failure reporting", () => {
  test("captures cli_command_failed with the command and code, never the message", async () => {
    const { run } = await import("../src/cli");
    const unknownBaseUrl = `http://127.0.0.1:9/run-failure-${crypto.randomUUID()}`;

    const exitCode = await run([
      "pipelines",
      "push",
      "project-1",
      "--base-url",
      unknownBaseUrl,
    ]);

    expect(exitCode).toBe(1);
    const failures = captureCalls.filter(
      (call) => call.event === "cli_command_failed",
    );
    expect(failures).toEqual([
      {
        distinctId: "anon-fixed-id",
        event: "cli_command_failed",
        properties: {
          command: "pipelines push",
          code: "not_signed_in_noninteractive",
          ...context("env"),
        },
      },
    ]);
    expect(shutdownCalls).toEqual([1500]);
  });
});
