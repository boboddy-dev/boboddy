import { afterEach, describe, expect, test } from "bun:test";
import {
  basicAuthHeader,
  generateServerPassword,
  probeReadiness,
  READINESS_PATH,
  waitForReadiness,
} from "../../../../src/runtime/runtime-service/infra/opencode-server-contract";

const PASSWORD = "test-password";
const EXPECTED_VERSION = "2.0.28";

type SeenRequest = { pathname: string; authorization: string | null };

type FakeServer = {
  baseUrl: string;
  requests: SeenRequest[];
  stop: () => void;
};

const servers: FakeServer[] = [];

function startFakeServer(handler: (request: Request) => Response): FakeServer {
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push({
        pathname: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      return handler(request);
    },
  });
  const fake = {
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
    requests,
    stop: () => {
      void server.stop(true);
    },
  };
  servers.push(fake);
  return fake;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

function probe(baseUrl: string) {
  return probeReadiness({
    baseUrl,
    password: PASSWORD,
    expectedVersion: EXPECTED_VERSION,
  });
}

describe("probeReadiness", () => {
  test("an HTML 200 (the web shell) is not-yet", async () => {
    const server = startFakeServer(
      () =>
        new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    expect((await probe(server.baseUrl)).kind).toBe("not-yet");
  });

  test("a 401 is not-yet", async () => {
    const server = startFakeServer(
      () => new Response("unauthorized", { status: 401 }),
    );

    expect(await probe(server.baseUrl)).toEqual({
      kind: "not-yet",
      reason: "HTTP 401",
    });
  });

  test("a JSON body with a different version is wrong-version", async () => {
    const server = startFakeServer(() => Response.json({ version: "1.17.3" }));

    expect(await probe(server.baseUrl)).toEqual({
      kind: "wrong-version",
      version: "1.17.3",
    });
  });

  test("a JSON body with the expected version is ready", async () => {
    const server = startFakeServer(() =>
      Response.json({ version: EXPECTED_VERSION }),
    );

    expect(await probe(server.baseUrl)).toEqual({
      kind: "ready",
      version: EXPECTED_VERSION,
    });
  });

  test("probes the readiness path with basic auth for the opencode user", async () => {
    const server = startFakeServer(() =>
      Response.json({ version: EXPECTED_VERSION }),
    );

    await probe(server.baseUrl);

    const request = server.requests[0];
    expect(request?.pathname).toBe(READINESS_PATH);
    expect(request?.authorization).toBe(
      `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
    );
  });

  test("a refused connection is not-yet", async () => {
    const server = startFakeServer(() => new Response(null));
    server.stop();

    expect((await probe(server.baseUrl)).kind).toBe("not-yet");
  });
});

describe("waitForReadiness", () => {
  test("keeps polling through 401s until the server is ready", async () => {
    let calls = 0;
    const server = startFakeServer(() => {
      calls += 1;
      return calls < 3
        ? new Response("unauthorized", { status: 401 })
        : Response.json({ version: EXPECTED_VERSION });
    });

    const result = await waitForReadiness({
      baseUrl: server.baseUrl,
      password: PASSWORD,
      expectedVersion: EXPECTED_VERSION,
      timeoutMs: 5_000,
      intervalMs: 250,
    });

    expect(result).toEqual({ kind: "ready", attempts: 3 });
  });

  test("stops immediately on a wrong version", async () => {
    const server = startFakeServer(() => Response.json({ version: "9.9.9" }));

    const result = await waitForReadiness({
      baseUrl: server.baseUrl,
      password: PASSWORD,
      expectedVersion: EXPECTED_VERSION,
      timeoutMs: 5_000,
      intervalMs: 2_000,
    });

    expect(result).toEqual({
      kind: "wrong-version",
      attempts: 1,
      version: "9.9.9",
    });
  });

  test("times out with the last not-yet reason", async () => {
    const server = startFakeServer(
      () => new Response("unauthorized", { status: 401 }),
    );

    const result = await waitForReadiness({
      baseUrl: server.baseUrl,
      password: PASSWORD,
      expectedVersion: EXPECTED_VERSION,
      timeoutMs: 100,
      intervalMs: 500,
    });

    expect(result.kind).toBe("timeout");
    expect(result.kind === "timeout" ? result.lastReason : null).toBe(
      "HTTP 401",
    );
  });

  test("aborts when assertAlive throws", async () => {
    const server = startFakeServer(
      () => new Response("unauthorized", { status: 401 }),
    );

    let outcome = "resolved";
    try {
      await waitForReadiness({
        baseUrl: server.baseUrl,
        password: PASSWORD,
        expectedVersion: EXPECTED_VERSION,
        timeoutMs: 5_000,
        intervalMs: 10,
        assertAlive: () => Promise.reject(new Error("process died")),
      });
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }

    expect(outcome).toBe("process died");
  });

  test("wakes from the pause between probes as soon as the signal aborts", async () => {
    const server = startFakeServer(
      () => new Response("unauthorized", { status: 401 }),
    );
    const controller = new AbortController();
    let dead = false;

    const startedAt = Date.now();
    const pending = waitForReadiness({
      baseUrl: server.baseUrl,
      password: PASSWORD,
      expectedVersion: EXPECTED_VERSION,
      timeoutMs: 60_000,
      intervalMs: 30_000,
      assertAlive: () =>
        dead ? Promise.reject(new Error("process died")) : Promise.resolve(),
      onNotReady: () => {
        setTimeout(() => {
          dead = true;
          controller.abort(new Error("exited"));
        }, 20);
      },
      signal: controller.signal,
    });

    let outcome = "resolved";
    try {
      await pending;
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }

    expect(outcome).toBe("process died");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe("generateServerPassword", () => {
  test("is 32 random bytes encoded as unpadded base64url", () => {
    const password = generateServerPassword();

    expect(password).toHaveLength(43);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(password, "base64url")).toHaveLength(32);
  });

  test("differs on every call", () => {
    expect(generateServerPassword()).not.toBe(generateServerPassword());
  });
});

describe("basicAuthHeader", () => {
  test("encodes opencode:<password>", () => {
    expect(basicAuthHeader("pw")).toBe(
      `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
    );
  });
});
