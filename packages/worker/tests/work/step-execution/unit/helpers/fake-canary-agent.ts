import { FakeAiServer } from "../../../../../src/work/step-execution/infra/fake-ai/fake-ai-server";
import type { McpHandshakeReport } from "../../../../../src/work/step-execution/application/run-work-dry-run-health-checks";

export type RecordedCall = { method: string; pathname: string };

export type FakeAgentScript = {
  configGet?: () => unknown;
  toolState?: { status: "completed" } | { status: "error"; error: string };
  /**
   * When set, `/message` returns an assistant message that failed outright and
   * no tool part at all — how a provider/harness failure actually looks, and
   * what `forceAndVerifyMcpCanary` turns into a `session-error`. `forTool`
   * narrows it to one qualified tool, so a multi-server run can fail partway.
   */
  assistantError?: {
    forTool?: string;
    name: "UnknownError";
    data: { message: string };
  };
};

const originalFetch = globalThis.fetch;

/** Undo {@link installFakeAgent}. Call from an `afterEach`. */
export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- test helper serializes arbitrary JSON fixtures
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A minimal router over `globalThis.fetch` covering everything
 * `runMcpCanaries` touches: `GET /config` (to resolve MCP server configs) plus
 * the session lifecycle `forceAndVerifyMcpCanary` drives underneath it.
 */
export function installFakeAgent(script: FakeAgentScript): {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  // The forced qualified tool name isn't otherwise visible to this router
  // (it's a request parameter to `forceAndVerifyMcpCanary`, not part of the
  // OpenCode wire shape) — recovered from the prompt text
  // (`Call the ${tool} tool to verify it works.`) so `/message` can echo back
  // a `ToolPart` for whichever tool was actually forced.
  let lastForcedTool = "unknown_tool";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    const method = request.method;
    calls.push({ method, pathname: url.pathname });

    if (method === "GET" && url.pathname === "/config") {
      return jsonResponse(script.configGet?.() ?? {});
    }
    if (method === "POST" && url.pathname === "/session") {
      return jsonResponse({ id: "canary-session" });
    }
    if (/^\/session\/[^/]+\/prompt_async$/.exec(url.pathname)) {
      const body = (await request.clone().json()) as {
        parts?: { text?: string }[];
      };
      const match = /Call the (\S+) tool/.exec(body.parts?.[0]?.text ?? "");
      lastForcedTool = match?.[1] ?? lastForcedTool;
      return jsonResponse({});
    }
    if (/^\/session\/[^/]+\/message$/.exec(url.pathname)) {
      const { assistantError } = script;
      if (
        assistantError &&
        (assistantError.forTool === undefined ||
          assistantError.forTool === lastForcedTool)
      ) {
        return jsonResponse([
          {
            info: {
              id: "msg-1",
              role: "assistant",
              error: { name: assistantError.name, data: assistantError.data },
            },
            parts: [],
          },
        ]);
      }
      const state = script.toolState ?? { status: "completed" };
      return jsonResponse([
        {
          info: { id: "msg-1", role: "assistant" },
          parts: [
            {
              id: "part-1",
              sessionID: "canary-session",
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: lastForcedTool,
              state:
                state.status === "completed"
                  ? {
                      status: "completed",
                      input: {},
                      output: "ok",
                      title: "echo",
                      metadata: {},
                      time: { start: 0, end: 1 },
                    }
                  : {
                      status: "error",
                      input: {},
                      error: state.error,
                      time: { start: 0, end: 1 },
                    },
            },
          ],
        },
      ]);
    }
    if (/^\/session\/[^/]+\/abort$/.exec(url.pathname)) {
      return jsonResponse(true);
    }
    if (/^\/session\/[^/]+$/.exec(url.pathname)) {
      return jsonResponse(true);
    }
    throw new Error(`Unhandled fake agent request: ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;

  return { calls };
}

export async function startedFakeAiServer(): Promise<FakeAiServer> {
  const server = new FakeAiServer();
  await server.start();
  return server;
}

export function handshake(
  overrides: Partial<McpHandshakeReport> = {},
): McpHandshakeReport {
  return {
    name: "fixture",
    status: "connected",
    error: undefined,
    healthy: true,
    ...overrides,
  };
}
