import { afterEach, describe, expect, test } from "bun:test";
import {
  forceAndVerifyMcpHealthCheck,
  type McpHealthCheckCall,
} from "../../../../src/work/task/application/force-and-verify-mcp-health-check";
import { FakeAiServer } from "../../../../src/work/task/infra/fake-ai/fake-ai-server";

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
  /** Called once per poll; return successive values to script pending → resolved. Newest first, like v2. */
  sessionMessages?: (id: string) => unknown[];
};

// eslint-disable-next-line local/no-unknown-parameter-type -- test helper serializes arbitrary JSON fixtures
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A minimal router over `globalThis.fetch` that mimics enough of a real v2 OpenCode server's `/api/*` routes to drive `forceAndVerifyMcpHealthCheck` end to end. */
function installFakeAgent(script: FakeAgentScript): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const route = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname: url.pathname, body });

    if (method === "POST" && url.pathname === "/api/session") {
      return jsonResponse({
        data: script.sessionCreate?.(body) ?? { id: "health-check-session" },
      });
    }
    if (
      method === "POST" &&
      /^\/api\/session\/[^/]+\/prompt$/.exec(url.pathname)
    ) {
      return jsonResponse({ data: { id: "inbox-1" } });
    }
    const messagesMatch = /^\/api\/session\/([^/]+)\/message$/.exec(
      url.pathname,
    );
    if (method === "GET" && messagesMatch?.[1]) {
      return jsonResponse({
        data: script.sessionMessages?.(messagesMatch[1]) ?? [],
        cursor: { previous: null, next: null },
      });
    }
    if (
      method === "POST" &&
      /^\/api\/session\/[^/]+\/interrupt$/.exec(url.pathname)
    ) {
      return jsonResponse({ interrupted: true });
    }
    if (method === "DELETE" && /^\/api\/session\/[^/]+$/.exec(url.pathname)) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unhandled fake agent request: ${method} ${url.pathname}`);
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      resolve(route(input, init));
    })) as typeof fetch;

  return { calls };
}

function assistantMessage(input: {
  id?: string;
  content?: unknown[];
  error?: { type: string; message: string };
}) {
  return {
    id: input.id ?? "msg-1",
    type: "assistant",
    time: { created: 0 },
    agent: "build",
    model: {
      id: "boboddy-healthchecker-model",
      providerID: "boboddy-healthchecker",
    },
    content: input.content ?? [],
    ...(input.error ? { finish: "error", error: input.error } : {}),
  };
}

function toolCallMessages(
  // eslint-disable-next-line local/no-unknown-parameter-type -- test helper: an arbitrary tool state fixture
  state: unknown,
  tool = "playwright_browser_navigate",
) {
  return [
    assistantMessage({
      content: [
        { type: "tool", id: "call-1", name: tool, time: { created: 0 }, state },
      ],
    }),
  ];
}

const COMPLETED_STATE = {
  status: "completed",
  input: {},
  content: [{ type: "text", text: "ok" }],
};

const healthCheck: McpHealthCheckCall = {
  tool: "playwright_browser_navigate",
  args: { url: "about:blank" },
};

async function startedFakeAiServer(): Promise<FakeAiServer> {
  const server = new FakeAiServer();
  await server.start();
  return server;
}

describe("forceAndVerifyMcpHealthCheck", () => {
  test("reports success when the tool call completes", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { calls } = installFakeAgent({
        sessionMessages: () => toolCallMessages(COMPLETED_STATE),
      });

      const result = await forceAndVerifyMcpHealthCheck({
        server: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthCheck,
        fakeAiServer,
        timeoutMs: 15_000,
        pollIntervalMs: 5,
      });

      expect(result).toEqual({ passed: true });

      // The fake-LLM server was configured with the exact qualified tool + args.
      expect(fakeAiServer.requestCount).toBe(0); // configure() never hits the network itself

      // The session was created, prompted, and cleaned up.
      const methods = calls.map((call) => `${call.method} ${call.pathname}`);
      expect(methods).toContain("POST /api/session");
      expect(methods).toContain(
        "POST /api/session/health-check-session/prompt",
      );
      expect(methods).toContain("DELETE /api/session/health-check-session");
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
        sessionMessages: () => toolCallMessages(COMPLETED_STATE),
      });

      await forceAndVerifyMcpHealthCheck({
        server: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthCheck,
        fakeAiServer,
        timeoutMs: 15_000,
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
          toolCallMessages({
            status: "error",
            input: {},
            error: {
              type: "unknown",
              message: "Browser has not been launched.",
            },
          }),
      });

      const result = await forceAndVerifyMcpHealthCheck({
        server: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthCheck,
        fakeAiServer,
        timeoutMs: 15_000,
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
          toolCallMessages({ status: "streaming", input: "{}" }),
      });

      const result = await forceAndVerifyMcpHealthCheck({
        server: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthCheck,
        fakeAiServer,
        timeoutMs: 50,
        pollIntervalMs: 5,
      });

      expect(result).toEqual({
        passed: false,
        reason: "timeout",
        detail: "timed out after 0s",
      });

      const methods = calls.map((call) => `${call.method} ${call.pathname}`);
      expect(methods).toContain(
        "POST /api/session/health-check-session/interrupt",
      );
      expect(methods).toContain("DELETE /api/session/health-check-session");
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
          assistantMessage({
            error: {
              type: "provider.auth",
              message:
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
            },
          }),
        ],
      });

      const result = await forceAndVerifyMcpHealthCheck({
        server: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthCheck,
        fakeAiServer,
        timeoutMs: 50,
        pollIntervalMs: 5,
      });

      expect(result).toEqual({
        passed: false,
        reason: "session-error",
        detail:
          "provider.auth: Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
      });

      // It bails out immediately rather than waiting out the timeout, so no abort.
      const methods = calls.map((call) => `${call.method} ${call.pathname}`);
      expect(methods).not.toContain(
        "POST /api/session/health-check-session/interrupt",
      );
      expect(methods).toContain("DELETE /api/session/health-check-session");
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("still passes when the tool call completed and a later assistant message errored", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        sessionMessages: () => [
          assistantMessage({
            id: "msg-2",
            error: { type: "provider.overloaded", message: "overloaded" },
          }),
          ...toolCallMessages(COMPLETED_STATE),
        ],
      });

      const result = await forceAndVerifyMcpHealthCheck({
        server: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthCheck,
        fakeAiServer,
        timeoutMs: 50,
        pollIntervalMs: 5,
      });

      expect(result).toEqual({ passed: true });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("treats a self-inflicted aborted step and interrupted idle marker as a timeout, not a session-error", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        sessionMessages: () => [
          {
            id: "msg-idle",
            type: "idle",
            time: { created: 1 },
            outcome: "interrupted",
          },
          assistantMessage({
            error: { type: "aborted", message: "Step interrupted" },
          }),
        ],
      });

      const result = await forceAndVerifyMcpHealthCheck({
        server: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthCheck,
        fakeAiServer,
        timeoutMs: 50,
        pollIntervalMs: 5,
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

      const result = await forceAndVerifyMcpHealthCheck({
        server: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthCheck,
        fakeAiServer,
        timeoutMs: 15_000,
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
