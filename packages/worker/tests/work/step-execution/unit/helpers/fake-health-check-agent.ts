import type {
  CliHealthCheck,
  HealthCheck,
  ToolHealthCheck,
} from "@boboddy/sdk/health-checks";
import { FakeAiServer } from "../../../../../src/work/step-execution/infra/fake-ai/fake-ai-server";
import type { McpHandshakeReport } from "../../../../../src/work/step-execution/application/run-work-dry-run-health-checks";

export type RecordedCall = { method: string; pathname: string };

/**
 * Tracks how many health-check sessions were open (created but not yet
 * deleted) at once, peaking at `max`. A reliable, non-flaky way to prove
 * `runHealthChecks` genuinely ran checks concurrently rather than one at a
 * time: `max === 1` means every session was created, used, and torn down
 * before the next one was created (fully sequential); `max > 1` means at
 * least two forced calls had overlapping sessions open (parallel lanes).
 * Doesn't depend on wall-clock timing or artificial delays — see
 * `installFakeAgent`.
 */
export type ConcurrentSessionTracker = { max: number };

/**
 * A single scripted tool-call outcome, keyed by qualified/resolved tool id in
 * {@link FakeAgentScript.toolStates}. `"completed"`'s `exit`/`output` default
 * to `0`/`"ok"` when omitted — the real bash tool's `metadata` shape per the
 * Phase-1 finding in `force-and-verify-cli-health-check.ts` — so every
 * existing test scripting a bare `{ status: "completed" }` (mcp-style checks,
 * which never read exit codes) keeps passing unchanged.
 */
export type ToolState =
  | { status: "completed"; exit?: number; output?: string }
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
 *
 * Session-scoped, not global: `runHealthChecks` can run several checks'
 * forced calls concurrently (parallel lanes — see `run-health-checks.ts`),
 * each getting its own session. A single shared "last forced tool" variable
 * would let one check's session see another's tool name if their requests
 * interleaved, exactly the race `buildForcedToolCallPrompt` /
 * `parseForcedToolCallFromMessages` exist to avoid in the real
 * `FakeAiServer` (`fake-ai-server.ts`) — this fake mirrors that fix by
 * keying the forced tool name off the session id instead.
 */
export function installFakeAgent(script: FakeAgentScript): {
  calls: RecordedCall[];
  concurrentSessions: ConcurrentSessionTracker;
} {
  const calls: RecordedCall[] = [];
  const forcedToolBySession = new Map<string, string>();
  const concurrentSessions: ConcurrentSessionTracker = { max: 0 };
  let openSessions = 0;
  let nextSessionSuffix = 0;

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
      nextSessionSuffix += 1;
      openSessions += 1;
      concurrentSessions.max = Math.max(concurrentSessions.max, openSessions);
      return jsonResponse({
        id: `health-check-session-${String(nextSessionSuffix)}`,
      });
    }
    const promptAsyncMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(
      url.pathname,
    );
    if (promptAsyncMatch) {
      const sessionId = promptAsyncMatch[1] ?? "";
      const body = (await request.clone().json()) as {
        parts?: { text?: string }[];
      };
      const match = /Call the (\S+) tool/.exec(body.parts?.[0]?.text ?? "");
      if (match?.[1]) {
        forcedToolBySession.set(sessionId, match[1]);
      }
      return jsonResponse({});
    }
    const messageMatch = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (messageMatch) {
      const sessionId = messageMatch[1] ?? "";
      const forcedTool = forcedToolBySession.get(sessionId) ?? "unknown_tool";
      const { assistantError } = script;
      if (
        assistantError &&
        (assistantError.forTool === undefined ||
          assistantError.forTool === forcedTool)
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
      const state: ToolState = script.toolStates?.[forcedTool] ??
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
              sessionID: sessionId,
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: forcedTool,
              state:
                state.status === "completed"
                  ? {
                      status: "completed",
                      input: {},
                      output: state.output ?? "ok",
                      title: "echo",
                      metadata: {
                        exit: state.exit ?? 0,
                        output: state.output ?? "ok",
                        truncated: false,
                      },
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
    if (method === "DELETE" && /^\/session\/[^/]+$/.exec(url.pathname)) {
      openSessions = Math.max(0, openSessions - 1);
      return jsonResponse(true);
    }
    if (/^\/session\/[^/]+$/.exec(url.pathname)) {
      return jsonResponse(true);
    }
    throw new Error(`Unhandled fake agent request: ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;

  return { calls, concurrentSessions };
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

/** Builds a fully-populated declared `"tool"`-kind `HealthCheck` for `runHealthChecks` (#119) tests. */
export function healthCheck(
  overrides: Partial<ToolHealthCheck> & { tool: string },
): HealthCheck {
  return {
    kind: "tool",
    tool: overrides.tool,
    mcp: overrides.mcp,
    name: overrides.name,
    args: overrides.args ?? {},
    severity: overrides.severity ?? "required",
    timeoutMs: overrides.timeoutMs ?? 15000,
    serialGroup: overrides.serialGroup,
  };
}

/** Builds a fully-populated declared `"cli"`-kind `HealthCheck` for `runHealthChecks` (#119) tests. */
export function cliHealthCheck(
  overrides: Partial<CliHealthCheck> & { command: string[] },
): HealthCheck {
  return {
    kind: "cli",
    command: overrides.command,
    name: overrides.name,
    severity: overrides.severity ?? "required",
    timeoutMs: overrides.timeoutMs ?? 15000,
    serialGroup: overrides.serialGroup,
    expectExitCode: overrides.expectExitCode ?? 0,
  };
}

export const GREET_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};
