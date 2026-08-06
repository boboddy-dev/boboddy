import { afterEach, describe, expect, test } from "bun:test";
import { runMcpCanaries } from "../../../../src/work/step-execution/application/run-work-dry-run-mcp-canaries";
import type { McpCanaryRegistryEntry } from "../../../../src/work/step-execution/application/mcp-canary-registry";
import {
  handshake,
  installFakeAgent,
  restoreFetch,
  startedFakeAiServer,
} from "./helpers/fake-canary-agent";

afterEach(() => {
  restoreFetch();
});

const fixtureRegistry: McpCanaryRegistryEntry[] = [
  {
    id: "fixture",
    matcher: { field: "name", pattern: /fixture/ },
    canary: { tool: "fixture_echo", args: { text: "ping" } },
  },
];

describe("runMcpCanaries", () => {
  test("returns an empty list without touching the network when there are no servers", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const calls: unknown[] = [];
      globalThis.fetch = (() => {
        calls.push(undefined);
        throw new Error("fetch should not be called");
      }) as unknown as typeof fetch;

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [],
        fakeAiServer,
      });

      expect(result).toEqual([]);
      expect(calls).toHaveLength(0);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("reports 'not-connected' for a server whose handshake never reached connected", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({ configGet: () => ({}) });

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [handshake({ status: "failed", healthy: false })],
        fakeAiServer,
      });

      expect(result).toEqual([
        {
          ...handshake({ status: "failed", healthy: false }),
          canary: { kind: "unverified", reason: "not-connected" },
        },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("reports 'not-local' when the resolved config has no entry for a connected server", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({ configGet: () => ({ mcp: {} }) });

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [handshake()],
        fakeAiServer,
      });

      expect(result[0]?.canary).toEqual({ kind: "unverified", reason: "not-local" });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("reports 'not-local' for a connected server that resolves to a remote config", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        configGet: () => ({
          mcp: { fixture: { type: "remote", url: "https://example.com/mcp" } },
        }),
      });

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [handshake()],
        fakeAiServer,
      });

      expect(result[0]?.canary).toEqual({ kind: "unverified", reason: "not-local" });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("passes through the registry's 'no-match' reason for a local server with no canary", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        configGet: () => ({
          mcp: { fixture: { type: "local", command: ["bun", "run", "fixture.ts"] } },
        }),
      });

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [handshake()],
        fakeAiServer,
        // Empty registry, so nothing can ever match.
        registry: [],
      });

      expect(result[0]?.canary).toEqual({ kind: "unverified", reason: "no-match" });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("passes through the registry's 'ambiguous-match' reason", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        configGet: () => ({
          mcp: { fixture: { type: "local", command: ["bun", "run", "fixture.ts"] } },
        }),
      });

      const ambiguousRegistry: McpCanaryRegistryEntry[] = [
        {
          id: "a",
          matcher: { field: "name", pattern: /fix/ },
          canary: { tool: "one", args: {} },
        },
        {
          id: "b",
          matcher: { field: "name", pattern: /ture/ },
          canary: { tool: "two", args: {} },
        },
      ];

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [handshake()],
        fakeAiServer,
        registry: ambiguousRegistry,
      });

      expect(result[0]?.canary).toEqual({
        kind: "unverified",
        reason: "ambiguous-match",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("runs the matched canary and reports 'ran-and-passed' when it succeeds", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      let configuredTool: string | undefined;
      const originalConfigure = fakeAiServer.configure.bind(fakeAiServer);
      fakeAiServer.configure = (toolName, toolArgs) => {
        configuredTool = toolName;
        return originalConfigure(toolName, toolArgs);
      };

      const { calls } = installFakeAgent({
        configGet: () => ({
          mcp: { fixture: { type: "local", command: ["bun", "run", "fixture.ts"] } },
        }),
        toolState: { status: "completed" },
      });

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [handshake()],
        fakeAiServer,
        registry: fixtureRegistry,
      });

      expect(result[0]?.canary).toEqual({ kind: "ran-and-passed" });
      // Qualified as `${serverName}_${tool}` per #108's convention.
      expect(configuredTool).toBe("fixture_fixture_echo");
      expect(calls.map((call) => `${call.method} ${call.pathname}`)).toContain(
        "GET /config",
      );
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("runs the matched canary and reports 'ran-and-failed' with the underlying detail when it fails", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        configGet: () => ({
          mcp: { fixture: { type: "local", command: ["bun", "run", "fixture.ts"] } },
        }),
        toolState: { status: "error", error: "boom: intentionally broken" },
      });

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [handshake()],
        fakeAiServer,
        registry: fixtureRegistry,
      });

      expect(result[0]?.canary).toEqual({
        kind: "ran-and-failed",
        reason: "tool-error",
        detail: "boom: intentionally broken",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("resolves each server's outcome independently, preserving order", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        configGet: () => ({
          mcp: {
            passing: { type: "local", command: ["bun", "run", "fixture.ts"] },
            disabled: { enabled: false },
          },
        }),
        toolState: { status: "completed" },
      });

      const registry: McpCanaryRegistryEntry[] = [
        {
          id: "passing",
          matcher: { field: "name", pattern: /passing/ },
          canary: { tool: "fixture_echo", args: {} },
        },
      ];

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: [
          handshake({ name: "passing" }),
          handshake({ name: "disabled", status: "disabled" }),
        ],
        fakeAiServer,
        registry,
      });

      expect(result.map((server) => server.name)).toEqual(["passing", "disabled"]);
      expect(result[0]?.canary).toEqual({ kind: "ran-and-passed" });
      expect(result[1]?.canary).toEqual({
        kind: "unverified",
        reason: "not-connected",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });
});
