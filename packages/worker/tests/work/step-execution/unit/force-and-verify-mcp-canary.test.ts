import { afterEach, describe, expect, test } from "bun:test";
import { forceAndVerifyMcpCanary } from "../../../../src/work/step-execution/application/force-and-verify-mcp-canary";
import { FakeAiServer } from "../../../../src/work/step-execution/infra/fake-ai/fake-ai-server";
import type { McpCanaryCall } from "../../../../src/work/step-execution/application/mcp-canary-registry";

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

type RecordedCall = { method: string; pathname: string; body: unknown };

// Test double: every scripted response body below is an arbitrary JSON
// fixture, so these are deliberately typed `unknown` rather than modeling
// the full OpenCode wire schema.
type FakeAgentScript = {
  // eslint-disable-next-line local/no-unknown-parameter-type -- see file comment above
  sessionCreate?: (body: unknown) => unknown;
  // eslint-disable-next-line local/no-unknown-parameter-type -- see file comment above
  sessionPromptAsync?: (id: string, body: unknown) => unknown;
  /** Called once per poll; return successive values to script pending → resolved. */
  sessionMessages?: (id: string) => unknown;
  sessionAbort?: (id: string) => unknown;
  sessionDelete?: (id: string) => unknown;
};

// eslint-disable-next-line local/no-unknown-parameter-type -- test helper serializes arbitrary JSON fixtures
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A minimal router over `globalThis.fetch` that mimics enough of a real OpenCode agent's HTTP API to drive `forceAndVerifyMcpCanary` end to end. */
function installFakeAgent(script: FakeAgentScript): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    const method = request.method;
    let body: unknown;
    if (method !== "GET" && method !== "DELETE") {
      body = await request.clone().json().catch(() => undefined);
    }
    calls.push({ method, pathname: url.pathname, body });

    if (method === "POST" && url.pathname === "/session") {
      return jsonResponse(script.sessionCreate?.(body) ?? { id: "canary-session" });
    }
    const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
    if (method === "POST" && promptMatch?.[1]) {
      return jsonResponse(script.sessionPromptAsync?.(promptMatch[1], body) ?? {});
    }
    const messagesMatch = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (method === "GET" && messagesMatch?.[1]) {
      return jsonResponse(script.sessionMessages?.(messagesMatch[1]) ?? []);
    }
    const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(url.pathname);
    if (method === "POST" && abortMatch?.[1]) {
      return jsonResponse(script.sessionAbort?.(abortMatch[1]) ?? true);
    }
    const deleteMatch = /^\/session\/([^/]+)$/.exec(url.pathname);
    if (method === "DELETE" && deleteMatch?.[1]) {
      return jsonResponse(script.sessionDelete?.(deleteMatch[1]) ?? true);
    }
    throw new Error(`Unhandled fake agent request: ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;

  return { calls };
}

// eslint-disable-next-line local/no-unknown-parameter-type -- test helper: an arbitrary ToolState fixture
function toolPartMessages(state: unknown, tool = "playwright_browser_navigate") {
  return [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          id: "part-1",
          sessionID: "canary-session",
          messageID: "msg-1",
          type: "tool",
          callID: "call-1",
          tool,
          state,
        },
      ],
    },
  ];
}

const canary: McpCanaryCall = {
  tool: "playwright_browser_navigate",
  args: { url: "about:blank" },
};

async function startedFakeAiServer(): Promise<FakeAiServer> {
  const server = new FakeAiServer();
  await server.start();
  return server;
}

describe("forceAndVerifyMcpCanary", () => {
  test("reports success when the tool call completes", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        sessionMessages: () =>
          toolPartMessages({
            status: "completed",
            input: {},
            output: "ok",
            title: "browser_navigate",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
      });

      const result = await forceAndVerifyMcpCanary({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        canary,
        fakeAiServer,
        pollIntervalMs: 5,
      });

      expect(result).toEqual({ passed: true });

      // The fake-LLM server was configured with the exact qualified tool + args.
      expect(fakeAiServer.requestCount).toBe(0); // configure() never hits the network itself

      // The session was created, prompted, and cleaned up.
      const methods = calls.map((call) => `${call.method} ${call.pathname}`);
      expect(methods).toContain("POST /session");
      expect(methods).toContain("POST /session/canary-session/prompt_async");
      expect(methods).toContain("DELETE /session/canary-session");
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("configures the fake-LLM server with the qualified tool name and args", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      let configuredToolName: string | undefined;
      let configuredToolArgs: unknown;
      const originalConfigure = fakeAiServer.configure.bind(fakeAiServer);
      fakeAiServer.configure = (toolName, toolArgs) => {
        configuredToolName = toolName;
        configuredToolArgs = toolArgs;
        return originalConfigure(toolName, toolArgs);
      };

      installFakeAgent({
        sessionMessages: () =>
          toolPartMessages({
            status: "completed",
            input: {},
            output: "ok",
            title: "browser_navigate",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
      });

      await forceAndVerifyMcpCanary({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        canary,
        fakeAiServer,
        pollIntervalMs: 5,
      });

      expect(configuredToolName).toBe("playwright_browser_navigate");
      expect(configuredToolArgs).toEqual({ url: "about:blank" });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("reports failure with the underlying MCP error when the tool call errors", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        sessionMessages: () =>
          toolPartMessages({
            status: "error",
            input: {},
            error: "Browser has not been launched.",
            time: { start: 0, end: 1 },
          }),
      });

      const result = await forceAndVerifyMcpCanary({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        canary,
        fakeAiServer,
        pollIntervalMs: 5,
      });

      expect(result).toEqual({
        passed: false,
        reason: "tool-error",
        detail: "Browser has not been launched.",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("aborts and reports a timeout when the tool call never resolves", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        // Always pending — the tool call never resolves within the timeout.
        sessionMessages: () =>
          toolPartMessages({ status: "pending", input: {}, raw: "{}" }),
      });

      const result = await forceAndVerifyMcpCanary({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        canary,
        fakeAiServer,
        timeoutMs: 200,
        pollIntervalMs: 20,
      });

      expect(result).toEqual({
        passed: false,
        reason: "timeout",
        detail: "timed out after 0s",
      });

      const methods = calls.map((call) => `${call.method} ${call.pathname}`);
      expect(methods).toContain("POST /session/canary-session/abort");
      expect(methods).toContain("DELETE /session/canary-session");
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("reports a session-error when an assistant message failed at the provider level", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        // No tool part ever appears — the whole turn died in the provider.
        sessionMessages: () => [
          {
            info: {
              id: "msg-1",
              role: "assistant",
              error: {
                name: "UnknownError",
                data: {
                  message:
                    "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
                },
              },
            },
            parts: [],
          },
        ],
      });

      const result = await forceAndVerifyMcpCanary({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        canary,
        fakeAiServer,
        timeoutMs: 200,
        pollIntervalMs: 20,
      });

      expect(result).toEqual({
        passed: false,
        reason: "session-error",
        detail:
          "UnknownError: Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
      });

      // It bails out immediately rather than waiting out the timeout, so no abort.
      const methods = calls.map((call) => `${call.method} ${call.pathname}`);
      expect(methods).not.toContain("POST /session/canary-session/abort");
      expect(methods).toContain("DELETE /session/canary-session");
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("still passes when the tool call completed and a later assistant message errored", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        sessionMessages: () => [
          ...toolPartMessages({
            status: "completed",
            input: {},
            output: "ok",
            title: "browser_navigate",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
          {
            info: {
              id: "msg-2",
              role: "assistant",
              error: { name: "APIError", data: { message: "overloaded", isRetryable: true } },
            },
            parts: [],
          },
        ],
      });

      const result = await forceAndVerifyMcpCanary({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        canary,
        fakeAiServer,
        timeoutMs: 200,
        pollIntervalMs: 20,
      });

      expect(result).toEqual({ passed: true });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("treats a self-inflicted MessageAbortedError as a timeout, not a session-error", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        sessionMessages: () => [
          {
            info: {
              id: "msg-1",
              role: "assistant",
              error: { name: "MessageAbortedError", data: { message: "aborted" } },
            },
            parts: [],
          },
        ],
      });

      const result = await forceAndVerifyMcpCanary({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        canary,
        fakeAiServer,
        timeoutMs: 200,
        pollIntervalMs: 20,
      });

      expect(result).toEqual({
        passed: false,
        reason: "timeout",
        detail: "timed out after 0s",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("still cleans up when session creation fails entirely", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        sessionCreate: () => {
          throw new Error("boom");
        },
      });

      const result = await forceAndVerifyMcpCanary({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        canary,
        fakeAiServer,
        pollIntervalMs: 5,
      });

      expect(result.passed).toBe(false);
      expect(result).toMatchObject({ reason: "session-error" });

      // No session was ever created, so there is nothing to delete.
      const deleteCalls = calls.filter((call) => call.method === "DELETE");
      expect(deleteCalls).toHaveLength(0);
    } finally {
      await fakeAiServer.stop();
    }
  });
});
