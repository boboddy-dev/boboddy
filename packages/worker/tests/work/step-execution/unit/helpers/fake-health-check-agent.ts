import type { HealthCheck } from "@boboddy/sdk/health-checks";
import { FakeAiServer } from "../../../../../src/work/step-execution/infra/fake-ai/fake-ai-server";
import type { McpHandshakeReport } from "../../../../../src/work/step-execution/application/run-work-dry-run-health-checks";

export type RecordedCall = { method: string; pathname: string };

/** A single scripted tool-call outcome, keyed by qualified/resolved tool id in {@link FakeAgentScript.toolStates}. */
export type ToolState =
  | { status: "completed" }
  | { status: "error"; error: string }
  /** Never resolves — used to test timeout handling. */
  | { status: "pending" };

export type FakeAgentScript = {
  configGet?: () => unknown;
  /**
   * `GET /mcp` — the warm-up poll `runHealthChecks` now runs before any
   * declared check. Defaults to an empty status map ("no MCP servers
   * configured"), which lets `pollMcpStatus`'s stability check settle after
   * its second read.
   */
  mcpStatus?: () => Record<string, unknown>;
  /** Enumeration endpoints the health check runner (#119) queries. */
  toolIds?: () => string[];
  toolList?: () => { id: string; description: string; parameters: unknown }[];
  /**
   * Single-tool-run scripting: applies regardless of which tool was actually
   * forced. Prefer {@link FakeAgentScript.toolStates} (keyed per tool) for
   * tests that force more than one tool per run.
   */
  toolState?: { status: "completed" } | { status: "error"; error: string };
  /** Keyed by resolved/qualified tool id. Takes precedence over `toolState` when the forced tool has an entry. */
  toolStates?: Record<string, ToolState>;
  /**
   * When set, `/message` returns an assistant message that failed outright and
   * no tool part at all — how a provider/harness failure actually looks, and
   * what `forceAndVerifyMcpHealthCheck` turns into a `session-error`. `forTool`
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
 * `runHealthChecks` (#119, declared checks) touches: `GET /config` (to
 * resolve MCP server configs), `GET /mcp` (the pre-checks warm-up poll),
 * the tool-enumeration endpoints (`/experimental/tool/ids`,
 * `/experimental/tool`), and the session lifecycle
 * `forceAndVerifyMcpHealthCheck` drives underneath it.
 */
export function installFakeAgent(script: FakeAgentScript): {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  // The forced qualified tool name isn't otherwise visible to this router
  // (it's a request parameter to `forceAndVerifyMcpHealthCheck`, not part of
  // the OpenCode wire shape) — recovered from the prompt text
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
    if (method === "GET" && url.pathname === "/mcp") {
      return jsonResponse(script.mcpStatus?.() ?? {});
    }
    if (method === "GET" && url.pathname === "/experimental/tool/ids") {
      return jsonResponse(script.toolIds?.() ?? []);
    }
    if (method === "GET" && url.pathname === "/experimental/tool") {
      return jsonResponse(script.toolList?.() ?? []);
    }
    if (method === "POST" && url.pathname === "/session") {
      return jsonResponse({ id: "health-check-session" });
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
      const state: ToolState = script.toolStates?.[lastForcedTool] ??
        script.toolState ?? { status: "completed" };
      if (state.status === "pending") {
        return jsonResponse([
          { info: { id: "msg-1", role: "assistant" }, parts: [] },
        ]);
      }
      return jsonResponse([
        {
          info: { id: "msg-1", role: "assistant" },
          parts: [
            {
              id: "part-1",
              sessionID: "health-check-session",
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

/** Builds a fully-populated declared `HealthCheck` for `runHealthChecks` (#119) tests. */
export function healthCheck(
  overrides: Partial<HealthCheck> & { tool: string },
): HealthCheck {
  return {
    tool: overrides.tool,
    mcp: overrides.mcp,
    name: overrides.name,
    args: overrides.args ?? {},
    severity: overrides.severity ?? "required",
    timeoutMs: overrides.timeoutMs ?? 15000,
  };
}

export const GREET_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};
