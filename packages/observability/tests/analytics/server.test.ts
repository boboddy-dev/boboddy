import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type CaptureArgs = {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
};
type IdentifyArgs = {
  distinctId: string;
  properties?: Record<string, unknown>;
};
type AliasArgs = {
  distinctId: string;
  alias: string;
};
type CaptureExceptionArgs = {
  error: Error;
  distinctId?: string;
  context?: Record<string, unknown>;
};
type ConstructedOptions = {
  host: string;
  flushAt?: number;
  flushInterval?: number;
};
type ConstructedArgs = { key: string; options: ConstructedOptions };

const captureCalls: CaptureArgs[] = [];
const identifyCalls: IdentifyArgs[] = [];
const aliasCalls: AliasArgs[] = [];
const captureExceptionCalls: CaptureExceptionArgs[] = [];
let shutdownCount = 0;
let flushCount = 0;
let flushShouldReject = false;
let constructedWith: ConstructedArgs[] = [];
let registeredListeners: string[] = [];

void mock.module("posthog-node", () => ({
  PostHog: class {
    constructor(key: string, options: ConstructedOptions) {
      constructedWith.push({ key, options });
    }
    on(event: string): () => void {
      registeredListeners.push(event);
      return () => undefined;
    }
    flush(): Promise<void> {
      flushCount += 1;
      return flushShouldReject
        ? Promise.reject(new Error("network down"))
        : Promise.resolve();
    }
    capture(args: CaptureArgs) {
      captureCalls.push(args);
    }
    identify(args: IdentifyArgs) {
      identifyCalls.push(args);
    }
    alias(args: AliasArgs) {
      aliasCalls.push(args);
    }
    captureException(
      error: Error,
      distinctId?: string,
      context?: Record<string, unknown>,
    ) {
      captureExceptionCalls.push({ error, distinctId, context });
    }
    shutdown(): Promise<void> {
      shutdownCount += 1;
      return Promise.resolve();
    }
  },
}));

const server = await import("../../src/analytics/server");

describe("server analytics wrapper", () => {
  beforeEach(() => {
    captureCalls.length = 0;
    identifyCalls.length = 0;
    aliasCalls.length = 0;
    captureExceptionCalls.length = 0;
    shutdownCount = 0;
    flushCount = 0;
    flushShouldReject = false;
    constructedWith = [];
    registeredListeners = [];
  });

  afterEach(async () => {
    await server.shutdown();
  });

  test("init constructs PostHog with the supplied key and host", () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    expect(constructedWith).toEqual([
      {
        key: "phc_server",
        options: {
          host: "https://t.boboddy.dev",
          // Batching must stay off: the API runs as a Vercel function that is
          // frozen once the response is returned, so queued events never ship.
          flushAt: 1,
          flushInterval: 0,
        },
      },
    ]);
  });

  test("captureSignup forwards distinctId, event, and properties", () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    server.captureSignup("user-1", {
      provider: "github",
      email_verified: true,
    });
    expect(captureCalls).toEqual([
      {
        distinctId: "user-1",
        event: "user_signed_up",
        properties: { provider: "github", email_verified: true },
      },
    ]);
  });

  test("calls before init are no-ops", () => {
    server.captureSignup("user-1", {
      provider: "github",
      email_verified: true,
    });
    expect(captureCalls).toEqual([]);
  });

  test("identify forwards distinctId and traits", () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    server.identify("user-1", { email: "x@example.test" });
    expect(identifyCalls).toEqual([
      { distinctId: "user-1", properties: { email: "x@example.test" } },
    ]);
  });

  test("alias forwards the current id and the id it replaces", () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    server.alias("user-1", "anon-1");
    expect(aliasCalls).toEqual([{ distinctId: "user-1", alias: "anon-1" }]);
  });

  test("alias is a no-op when the ids are already the same", () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    server.alias("user-1", "user-1");
    expect(aliasCalls).toEqual([]);
  });

  test("alias before init is a no-op", () => {
    server.alias("user-1", "anon-1");
    expect(aliasCalls).toEqual([]);
  });

  test("captureApiEndpointTiming forwards the timing event and properties", () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    server.captureApiEndpointTiming("user-1", {
      method: "GET",
      route: "/api/projects/:projectId",
      status_code: 200,
      duration_ms: 12.34,
      ok: true,
      operation_id: "getProject",
      tags: ["Projects"],
    });
    expect(captureCalls).toEqual([
      {
        distinctId: "user-1",
        event: "api_endpoint_timed",
        properties: {
          method: "GET",
          route: "/api/projects/:projectId",
          status_code: 200,
          duration_ms: 12.34,
          ok: true,
          operation_id: "getProject",
          tags: ["Projects"],
        },
      },
    ]);
  });

  test("captureException forwards error and identifiers", () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    const err = new Error("boom");
    server.captureException(err, "user-1", { tag: "x" });
    expect(captureExceptionCalls).toEqual([
      { error: err, distinctId: "user-1", context: { tag: "x" } },
    ]);
  });

  test("init subscribes to delivery errors so they are not silent", () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    expect(registeredListeners).toContain("error");
  });

  test("flush drains the queue without tearing the client down", async () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    await server.flush();
    expect(flushCount).toBe(1);
    // Still usable afterwards — unlike shutdown(), which nulls the client.
    server.captureSignup("user-1", { provider: "email", email_verified: true });
    expect(captureCalls).toHaveLength(1);
  });

  test("flush before init is a no-op", async () => {
    await server.flush();
    expect(flushCount).toBe(0);
  });

  test("flush swallows delivery errors", async () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    flushShouldReject = true;
    // A failed analytics delivery must never reject into the request path.
    await server.flush();
    expect(flushCount).toBe(1);
  });

  test("shutdown clears the client so re-init constructs a new one", async () => {
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    await server.shutdown();
    expect(shutdownCount).toBe(1);
    server.init({ key: "phc_server", host: "https://t.boboddy.dev" });
    expect(constructedWith).toHaveLength(2);
  });
});
