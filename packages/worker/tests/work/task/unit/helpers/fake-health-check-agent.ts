import type {
  CliHealthCheck,
  HealthCheck,
  ToolHealthCheck,
} from "@boboddy/sdk/health-checks";
import { FakeAiServer } from "../../../../../src/work/task/infra/fake-ai/fake-ai-server";
import type { McpHandshakeReport } from "../../../../../src/work/task/application/run-work-dry-run-health-checks";

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
 * to `0`/`"ok"` when omitted and are rendered the way a real v2 `shell` call
 * reports them (see `force-and-verify-cli-health-check.ts`), so a bare
 * `{ status: "completed" }` works for mcp-style checks, which never read exit
 * codes. `"error"`'s `error` becomes the message of a structured
 * `{ type: "unknown", message }` tool error — the shape v2 gives a tool that
 * throws.
 */
export type ToolState =
  | { status: "completed"; exit?: number; output?: string }
  | { status: "error"; error: string }
  /** Never resolves — used to test timeout handling. */
  | { status: "pending" };

export type FakeAgentScript = {
  /**
   * `GET /api/mcp` — the warm-up poll `runHealthChecks` runs before any
   * declared check. Defaults to a connected `fixture` server, which lets
   * `pollMcpStatus`'s stability check settle after its second read for
   * checks qualified with `mcp: "fixture"`.
   */
  mcpServers?: () => Array<{
    name: string;
    status: { status: string; error?: string };
  }>;
  /**
   * `POST /api/rpc/boboddy/listTools` — the plugin's tool enumeration. A tool
   * with no `inputSchema` is reported with `null`, as the plugin does for
   * tools not declared with a plain JSON Schema.
   */
  tools?: () => Array<{ id: string; inputSchema?: Record<string, unknown> }>;
  /** Keyed by resolved/qualified tool id. Defaults to `{ status: "completed" }`. */
  toolStates?: Record<string, ToolState>;
  /**
   * When set, the session's messages hold an assistant step that failed
   * outright and no tool call at all — how a provider/harness failure
   * actually looks, and what the verifiers turn into a `session-error`.
   * `forTool` narrows it to one qualified tool, so a multi-server run can
   * fail partway.
   */
  assistantError?: {
    forTool?: string;
    type: string;
    message: string;
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

function toolContent(state: ToolState, forcedTool: string, callIndex: number) {
  const base = {
    type: "tool",
    id: `call-${String(callIndex)}`,
    name: forcedTool,
    time: { created: 0 },
  };
  switch (state.status) {
    case "pending":
      return { ...base, state: { status: "streaming", input: "" } };
    case "completed": {
      const exit = state.exit ?? 0;
      return {
        ...base,
        state: {
          status: "completed",
          input: {},
          content: [
            { type: "text", text: state.output ?? "ok" },
            { type: "text", text: `Exited with code ${String(exit)}` },
          ],
          metadata: { status: "completed", truncated: false, exit },
        },
      };
    }
    case "error":
      return {
        ...base,
        state: {
          status: "error",
          input: {},
          error: { type: "unknown", message: state.error },
        },
      };
  }
}

function assistantMessage(
  content: unknown[],
  error?: { type: string; message: string },
) {
  return {
    id: "msg-assistant",
    type: "assistant",
    time: { created: 0 },
    agent: "build",
    model: {
      id: "boboddy-healthchecker-model",
      providerID: "boboddy-healthchecker",
    },
    content,
    ...(error ? { finish: "error", error } : {}),
  };
}

/**
 * A minimal router over `globalThis.fetch` covering every v2 `/api/*` route
 * `runHealthChecks` touches: `GET /api/mcp` (the pre-checks warm-up poll),
 * the plugin's `POST /api/rpc/boboddy/listTools` enumeration, and the session
 * lifecycle the forced-call verifiers drive (`POST /api/session`,
 * `POST /api/session/{id}/prompt`, `GET /api/session/{id}/message`,
 * `POST /api/session/{id}/interrupt`, `DELETE /api/session/{id}`).
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
export function installFakeAgent(script: FakeAgentScript = {}): {
  calls: RecordedCall[];
  concurrentSessions: ConcurrentSessionTracker;
} {
  const calls: RecordedCall[] = [];
  const forcedToolBySession = new Map<string, string>();
  const concurrentSessions: ConcurrentSessionTracker = { max: 0 };
  let openSessions = 0;
  let nextSessionSuffix = 0;

  const route = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    calls.push({ method, pathname: url.pathname });

    if (method === "GET" && url.pathname === "/api/mcp") {
      return jsonResponse({
        location: { directory: "/workspaces/repo" },
        data: script.mcpServers?.() ?? [
          { name: "fixture", status: { status: "connected" } },
        ],
      });
    }
    if (method === "POST" && url.pathname === "/api/rpc/boboddy/listTools") {
      return jsonResponse({
        output: {
          tools: (script.tools?.() ?? []).map((tool) => ({
            id: tool.id,
            inputSchema: tool.inputSchema ?? null,
          })),
        },
      });
    }
    if (method === "POST" && url.pathname === "/api/session") {
      nextSessionSuffix += 1;
      openSessions += 1;
      concurrentSessions.max = Math.max(concurrentSessions.max, openSessions);
      return jsonResponse({
        data: { id: `health-check-session-${String(nextSessionSuffix)}` },
      });
    }
    const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
    if (method === "POST" && promptMatch) {
      const sessionId = promptMatch[1] ?? "";
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as { text?: string };
      const match = /Call the (\S+) tool/.exec(body.text ?? "");
      if (match?.[1]) {
        forcedToolBySession.set(sessionId, match[1]);
      }
      return jsonResponse({ data: { id: "inbox-1" } });
    }
    const messageMatch = /^\/api\/session\/([^/]+)\/message$/.exec(
      url.pathname,
    );
    if (method === "GET" && messageMatch) {
      const sessionId = messageMatch[1] ?? "";
      const forcedTool = forcedToolBySession.get(sessionId) ?? "unknown_tool";
      const { assistantError } = script;
      const page = (data: unknown[]) =>
        jsonResponse({ data, cursor: { previous: null, next: null } });
      if (
        assistantError &&
        (assistantError.forTool === undefined ||
          assistantError.forTool === forcedTool)
      ) {
        return page([
          assistantMessage([], {
            type: assistantError.type,
            message: assistantError.message,
          }),
        ]);
      }
      const state: ToolState = script.toolStates?.[forcedTool] ?? {
        status: "completed",
      };
      return page([assistantMessage([toolContent(state, forcedTool, 1)])]);
    }
    if (
      method === "POST" &&
      /^\/api\/session\/[^/]+\/interrupt$/.exec(url.pathname)
    ) {
      return jsonResponse({ interrupted: true });
    }
    if (method === "DELETE" && /^\/api\/session\/[^/]+$/.exec(url.pathname)) {
      openSessions = Math.max(0, openSessions - 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unhandled fake agent request: ${method} ${url.pathname}`);
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      resolve(route(input, init));
    })) as typeof fetch;

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
    timeoutSeconds: overrides.timeoutSeconds ?? 15,
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
    timeoutSeconds: overrides.timeoutSeconds ?? 15,
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
