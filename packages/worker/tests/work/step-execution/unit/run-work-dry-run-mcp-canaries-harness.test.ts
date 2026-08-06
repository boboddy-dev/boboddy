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

/** Matches any of the fixture servers below, so every one of them is canaried. */
const anyFixtureRegistry: McpCanaryRegistryEntry[] = [
  {
    id: "any",
    matcher: { field: "args", pattern: /fixture\.ts/ },
    canary: { tool: "echo", args: {} },
  },
];

const threeLocalServers = () => ({
  mcp: {
    first: { type: "local", command: ["bun", "run", "fixture.ts"] },
    second: { type: "local", command: ["bun", "run", "fixture.ts"] },
    third: { type: "local", command: ["bun", "run", "fixture.ts"] },
  },
});

const threeHandshakes = [
  handshake({ name: "first" }),
  handshake({ name: "second" }),
  handshake({ name: "third" }),
];

describe("runMcpCanaries harness short-circuit", () => {
  test("stops launching canaries after the first session-error", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        configGet: threeLocalServers,
        assistantError: {
          name: "UnknownError",
          data: { message: "Claude Code credentials are unavailable or expired." },
        },
      });

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: threeHandshakes,
        fakeAiServer,
        registry: anyFixtureRegistry,
      });

      // The server that actually errored keeps the real cause...
      expect(result[0]?.canary).toEqual({
        kind: "ran-and-failed",
        reason: "session-error",
        detail: "UnknownError: Claude Code credentials are unavailable or expired.",
      });
      // ...and the rest are reported unverified, not blamed individually.
      expect(result.slice(1).map((server) => server.canary)).toEqual([
        { kind: "unverified", reason: "harness-unavailable" },
        { kind: "unverified", reason: "harness-unavailable" },
      ]);
      // Exactly one canary session was ever created: no further canary ran.
      expect(
        calls.filter(
          (call) => call.method === "POST" && call.pathname === "/session",
        ),
      ).toHaveLength(1);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("keeps verdicts produced before the session-error", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        configGet: threeLocalServers,
        assistantError: {
          forTool: "second_echo",
          name: "UnknownError",
          data: { message: "provider is down" },
        },
      });

      const result = await runMcpCanaries({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        mcpServers: threeHandshakes,
        fakeAiServer,
        registry: anyFixtureRegistry,
      });

      expect(result.map((server) => server.canary)).toEqual([
        { kind: "ran-and-passed" },
        {
          kind: "ran-and-failed",
          reason: "session-error",
          detail: "UnknownError: provider is down",
        },
        { kind: "unverified", reason: "harness-unavailable" },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });
});
