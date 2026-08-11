import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthProfile } from "@boboddy/worker";

/**
 * `telemetry.ts` reaches into two real modules that must not touch the
 * network or the developer's real `~/.boboddy.json` in a test run:
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
let flushCount = 0;
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
  flush: () => {
    flushCount += 1;
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

const telemetry = await import("../src/lib/telemetry");

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
  flushCount = 0;
  initialized = false;
  captureShouldThrow = false;
  getOrCreateAnonymousIdCalls = 0;
  fakeAnonymousId = "anon-fixed-id";
  fakeTelemetryDisabled = false;
  fakeProfiles = {};
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
        properties: undefined,
      },
    ]);
  });

  test("forwards properties untouched", () => {
    telemetry.captureMilestone("cli_project_linked", { linked: "new" });
    expect(captureCalls).toEqual([
      {
        distinctId: "anon-fixed-id",
        event: "cli_project_linked",
        properties: { linked: "new" },
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
        properties: undefined,
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

describe("flushTelemetry", () => {
  test("awaits the underlying flush when telemetry was initialized", async () => {
    telemetry.captureMilestone("cli_init_started");
    await telemetry.flushTelemetry();
    expect(flushCount).toBe(1);
  });

  test("is a no-op when telemetry was never initialized", async () => {
    await telemetry.flushTelemetry();
    expect(flushCount).toBe(0);
  });

  test("resolves even if the underlying flush hangs, once the timeout elapses", async () => {
    telemetry.captureMilestone("cli_init_started");
    await telemetry.flushTelemetry(5);
    expect(flushCount).toBe(1);
  });
});
