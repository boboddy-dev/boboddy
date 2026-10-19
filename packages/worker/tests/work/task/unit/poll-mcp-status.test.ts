import { afterEach, describe, expect, test } from "bun:test";
import { pollMcpStatus } from "../../../../src/work/task/application/poll-mcp-status";

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

// eslint-disable-next-line local/no-unknown-parameter-type -- test helper serializes arbitrary JSON fixtures
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A v2 `GET /api/mcp` response body. */
function mcpListResponse(
  servers: Array<{ name: string; status: { status: string; error?: string } }>,
): Response {
  return jsonResponse({
    location: { directory: "/workspaces/repo" },
    data: servers,
  });
}

describe("pollMcpStatus", () => {
  test("marks connected and disabled servers healthy, others unhealthy", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        mcpListResponse([
          { name: "github", status: { status: "connected" } },
          { name: "slack", status: { status: "disabled" } },
          { name: "jira", status: { status: "failed", error: "spawn ENOENT" } },
          {
            name: "notion",
            status: { status: "needs_auth", error: "login required" },
          },
        ]),
      )) as unknown as typeof fetch;

    const report = await pollMcpStatus(
      {
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
        workspaceFolder: "/workspaces/repo",
      },
      {
        windowMs: 200,
        intervalMs: 5,
      },
    );

    expect(report).toEqual([
      { name: "github", status: "connected", error: undefined, healthy: true },
      { name: "jira", status: "failed", error: "spawn ENOENT", healthy: false },
      {
        name: "notion",
        status: "needs_auth",
        error: "login required",
        healthy: false,
      },
      { name: "slack", status: "disabled", error: undefined, healthy: true },
    ]);
  });

  test("returns an empty list when no MCP servers are configured", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(mcpListResponse([]))) as unknown as typeof fetch;

    const report = await pollMcpStatus(
      {
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
        workspaceFolder: "/workspaces/repo",
      },
      {
        windowMs: 200,
        intervalMs: 5,
      },
    );

    expect(report).toEqual([]);
  });

  test("keeps polling while a server is still pending, even across identical reads", async () => {
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount += 1;
      return Promise.resolve(
        mcpListResponse([
          { name: "playwright", status: { status: "connected" } },
          {
            name: "postgres",
            status: { status: callCount <= 4 ? "pending" : "connected" },
          },
        ]),
      );
    }) as unknown as typeof fetch;

    const report = await pollMcpStatus(
      {
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
        workspaceFolder: "/workspaces/repo",
      },
      {
        windowMs: 2_000,
        intervalMs: 5,
      },
    );

    expect(callCount).toBe(6);
    expect(report).toEqual([
      {
        name: "playwright",
        status: "connected",
        error: undefined,
        healthy: true,
      },
      {
        name: "postgres",
        status: "connected",
        error: undefined,
        healthy: true,
      },
    ]);
  });

  test("keeps polling until every expected server is listed, even across identical empty reads", async () => {
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount += 1;
      return Promise.resolve(
        mcpListResponse(
          callCount <= 3
            ? []
            : [{ name: "fixture", status: { status: "connected" } }],
        ),
      );
    }) as unknown as typeof fetch;

    const report = await pollMcpStatus(
      {
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
        workspaceFolder: "/workspaces/repo",
      },
      {
        windowMs: 2_000,
        intervalMs: 5,
        expectedServers: ["fixture"],
      },
    );

    expect(callCount).toBe(5);
    expect(report).toEqual([
      { name: "fixture", status: "connected", error: undefined, healthy: true },
    ]);
  });

  test("returns the pending status if a server never connects within the window", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        mcpListResponse([{ name: "postgres", status: { status: "pending" } }]),
      )) as unknown as typeof fetch;

    const report = await pollMcpStatus(
      {
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
        workspaceFolder: "/workspaces/repo",
      },
      {
        windowMs: 100,
        intervalMs: 5,
      },
    );

    expect(report).toEqual([
      { name: "postgres", status: "pending", error: undefined, healthy: false },
    ]);
  });

  test("settles on the last-read status if the poll window times out mid-flap", async () => {
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount += 1;
      // Every call reports a different status, so the two-consecutive-polls
      // stability check never triggers and the window must elapse.
      const status = callCount % 2 === 0 ? "connected" : "failed";
      return Promise.resolve(
        mcpListResponse([
          {
            name: "flaky",
            status:
              status === "failed" ? { status, error: "boom" } : { status },
          },
        ]),
      );
    }) as unknown as typeof fetch;

    const report = await pollMcpStatus(
      {
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
        workspaceFolder: "/workspaces/repo",
      },
      {
        windowMs: 200,
        intervalMs: 5,
      },
    );

    expect(report).toHaveLength(1);
    expect(report[0]?.name).toBe("flaky");
  });
});
