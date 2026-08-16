import { afterEach, describe, expect, test } from "bun:test";
import { pollMcpStatus } from "../../../../src/work/step-execution/application/poll-mcp-status";

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

describe("pollMcpStatus", () => {
  test("marks connected and disabled servers healthy, others unhealthy", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        jsonResponse({
          github: { status: "connected" },
          slack: { status: "disabled" },
          jira: { status: "failed", error: "spawn ENOENT" },
          notion: { status: "needs_auth" },
        }),
      )) as unknown as typeof fetch;

    const report = await pollMcpStatus("http://127.0.0.1:4096", "/workspaces/repo", {
      windowMs: 200,
      intervalMs: 20,
    });

    expect(report).toEqual([
      { name: "github", status: "connected", error: undefined, healthy: true },
      { name: "jira", status: "failed", error: "spawn ENOENT", healthy: false },
      { name: "notion", status: "needs_auth", error: undefined, healthy: false },
      { name: "slack", status: "disabled", error: undefined, healthy: true },
    ]);
  });

  test("returns an empty list when no MCP servers are configured", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(jsonResponse({}))) as unknown as typeof fetch;

    const report = await pollMcpStatus("http://127.0.0.1:4096", "/workspaces/repo", {
      windowMs: 200,
      intervalMs: 20,
    });

    expect(report).toEqual([]);
  });

  test("settles on the last-read status if the poll window times out mid-flap", async () => {
    let callCount = 0;
    globalThis.fetch = (() => {
      callCount += 1;
      // Every call reports a different status, so the two-consecutive-polls
      // stability check never triggers and the window must elapse.
      const status = callCount % 2 === 0 ? "connected" : "failed";
      return Promise.resolve(
        jsonResponse({ flaky: { status, error: status === "failed" ? "boom" : undefined } }),
      );
    }) as unknown as typeof fetch;

    const report = await pollMcpStatus("http://127.0.0.1:4096", "/workspaces/repo", {
      windowMs: 200,
      intervalMs: 20,
    });

    expect(report).toHaveLength(1);
    expect(report[0]?.name).toBe("flaky");
  });
});
