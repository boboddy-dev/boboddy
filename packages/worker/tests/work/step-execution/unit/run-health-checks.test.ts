import { afterEach, describe, expect, test } from "bun:test";
import { runHealthChecks } from "../../../../src/work/step-execution/application/run-health-checks";
import {
  GREET_SCHEMA,
  healthCheck,
  installFakeAgent,
  restoreFetch,
  startedFakeAiServer,
} from "./helpers/fake-health-check-agent";

afterEach(() => {
  restoreFetch();
});

describe("runHealthChecks", () => {
  test("returns an empty list without touching the network when there are no checks", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      globalThis.fetch = (() => {
        throw new Error("fetch should not be called");
      }) as unknown as typeof fetch;

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [],
        fakeAiServer,
      });

      expect(result).toEqual([]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("passes a registered plugin/standalone-style tool with valid args", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolIds: () => ["greet", "bash"],
        toolList: () => [
          { id: "greet", description: "greets", parameters: GREET_SCHEMA },
        ],
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [healthCheck({ tool: "greet", args: { name: "Ada" } })],
        fakeAiServer,
      });

      expect(result).toEqual([
        {
          name: "greet",
          resolvedId: "greet",
          severity: "required",
          outcome: { kind: "passed" },
        },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("fails fast as not-registered, carrying the available ids, without attempting the call", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        toolIds: () => ["bash", "read"],
      });

      const startedAt = Date.now();
      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [healthCheck({ tool: "totally-fake-tool" })],
        fakeAiServer,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(result).toHaveLength(1);
      expect(result[0]?.outcome).toEqual({
        kind: "failed",
        reason: "not-registered",
        detail:
          'Tool "totally-fake-tool" is not registered in this environment.',
        availableIds: ["bash", "read"],
      });
      // Fails fast: no session was ever created for the forced call.
      expect(calls.some((call) => call.pathname === "/session")).toBe(false);
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("fails as an authoring error when args violate the tool's real schema, without attempting the call", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        toolIds: () => ["greet"],
        toolList: () => [
          { id: "greet", description: "greets", parameters: GREET_SCHEMA },
        ],
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        // Missing the required `name` property.
        healthChecks: [healthCheck({ tool: "greet", args: {} })],
        fakeAiServer,
      });

      expect(result[0]?.outcome.kind).toBe("failed");
      if (result[0]?.outcome.kind === "failed") {
        expect(result[0].outcome.reason).toBe("invalid-args");
        expect(result[0].outcome.detail).toContain("required property");
      }
      expect(calls.some((call) => call.pathname === "/session")).toBe(false);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("skips id resolution and schema validation entirely for an mcp-qualified check", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        toolStates: { fixture_echo: { status: "completed" } },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({ mcp: "fixture", tool: "echo", args: { text: "hi" } }),
        ],
        fakeAiServer,
      });

      expect(result[0]?.outcome).toEqual({ kind: "passed" });
      expect(
        calls.some((call) => call.pathname === "/experimental/tool/ids"),
      ).toBe(false);
      expect(calls.some((call) => call.pathname === "/experimental/tool")).toBe(
        false,
      );
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("reports a real MCP tool-call failure via the underlying detail", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          fixture_boom: {
            status: "error",
            error: "boom: intentionally broken fixture tool",
          },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [healthCheck({ mcp: "fixture", tool: "boom" })],
        fakeAiServer,
      });

      expect(result[0]?.outcome).toEqual({
        kind: "failed",
        reason: "tool-error",
        detail: "boom: intentionally broken fixture tool",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("runs required checks in order and aborts every check after the first required failure", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          fixture_pass_a: { status: "completed" },
          fixture_fail_b: {
            status: "error",
            error: "b is broken",
          },
          fixture_pass_c: { status: "completed" },
          fixture_pass_d: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({ mcp: "fixture", tool: "pass_a", severity: "required" }),
          healthCheck({ mcp: "fixture", tool: "fail_b", severity: "required" }),
          healthCheck({ mcp: "fixture", tool: "pass_c", severity: "required" }),
          healthCheck({ mcp: "fixture", tool: "pass_d", severity: "warn" }),
        ],
        fakeAiServer,
      });

      expect(result.map((report) => report.outcome)).toEqual([
        { kind: "passed" },
        { kind: "failed", reason: "tool-error", detail: "b is broken" },
        { kind: "skipped" },
        { kind: "skipped" },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("runs warn checks after all required checks pass, and a warn failure doesn't skip later warn checks", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          fixture_required_check: { status: "completed" },
          fixture_warn_fails: {
            status: "error",
            error: "advisory server is down",
          },
          fixture_warn_passes: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "required_check",
            severity: "required",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "warn_fails",
            severity: "warn",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "warn_passes",
            severity: "warn",
          }),
        ],
        fakeAiServer,
      });

      expect(result.map((report) => report.outcome)).toEqual([
        { kind: "passed" },
        {
          kind: "failed",
          reason: "tool-error",
          detail: "advisory server is down",
        },
        { kind: "passed" },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("runs required checks declared after a warn check before that warn check", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          fixture_warn_first: { status: "completed" },
          fixture_required_second: {
            status: "error",
            error: "required tool is broken",
          },
        },
      });

      // Declared in interleaved order: warn, then required.
      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "warn_first",
            severity: "warn",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "required_second",
            severity: "required",
          }),
        ],
        fakeAiServer,
      });

      // The required check runs (and fails) before the warn check is
      // reached, even though it was declared second — required-before-advisory
      // ordering, per #113. The abort caused by the required failure then
      // skips the warn check.
      expect(result.map((report) => report.outcome)).toEqual([
        { kind: "skipped" },
        {
          kind: "failed",
          reason: "tool-error",
          detail: "required tool is broken",
        },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("names each report from the check's declared name, defaulting to the resolved id", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: { fixture_browser_navigate: { status: "completed" } },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "browser_navigate",
            name: "Browser reachable",
          }),
        ],
        fakeAiServer,
      });

      expect(result[0]?.name).toBe("Browser reachable");
      expect(result[0]?.resolvedId).toBe("fixture_browser_navigate");
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("honours a per-check timeoutMs rather than falling back to a much larger default", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: { fixture_never_resolves: { status: "pending" } },
      });

      // If the runner ignored this and fell back to a large default, this
      // test would exceed bun's default per-test timeout instead of
      // resolving with a `timeout` outcome.
      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "never_resolves",
            timeoutMs: 100,
          }),
        ],
        fakeAiServer,
      });

      expect(result[0]?.outcome).toEqual({
        kind: "failed",
        reason: "timeout",
        detail: "timed out after 0s",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });
});

describe("runHealthChecks — MCP warm-up", () => {
  // Regression test for the bug the warm-up poll (in `runHealthChecks`,
  // right after its `healthChecks.length === 0` early return) fixes: a
  // real, non-dry-run step execution could spuriously fail a health check
  // against a slow-starting MCP server (e.g. Playwright/Chromium cold-start)
  // because the forced call's own timeout clock started the instant the
  // server was declared "ready" rather than after the MCP server had
  // actually finished connecting. Without the warm-up poll, `GET /mcp` is
  // never queried at all before the forced call — this test would have
  // failed on that basis alone (0 calls, not >1) before the fix landed.
  test("polls MCP status to stability before forcing the declared check's tool call", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      let mcpStatusCalls = 0;
      const { calls } = installFakeAgent({
        // Simulates a still-connecting server: the first read differs from
        // every read after it, so `pollMcpStatus`'s stability check (two
        // consecutive identical reads) can't settle on the very first poll —
        // it only stabilizes once the "connected" report repeats.
        mcpStatus: () => {
          mcpStatusCalls += 1;
          return mcpStatusCalls === 1
            ? { playwright: { status: "connecting" } }
            : { playwright: { status: "connected" } };
        },
        toolStates: {
          playwright_browser_navigate: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "playwright",
            tool: "browser_navigate",
            args: { url: "about:blank" },
            severity: "required",
          }),
        ],
        fakeAiServer,
      });

      expect(result[0]?.outcome).toEqual({ kind: "passed" });
      // Proves the warm-up loop actually ran to stability (not a single
      // read) before the check was forced — without the warm-up call this
      // count would be 0, since nothing else in `runHealthChecks` ever
      // queries `GET /mcp`.
      expect(mcpStatusCalls).toBeGreaterThan(1);
      expect(calls.filter((call) => call.pathname === "/mcp")).toHaveLength(
        mcpStatusCalls,
      );
    } finally {
      await fakeAiServer.stop();
    }
  });
});
