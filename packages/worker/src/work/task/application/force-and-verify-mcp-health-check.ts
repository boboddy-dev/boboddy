import { TASK_AGENT } from "@boboddy/opencode-plugin";
import type { FakeAiServer } from "../infra/fake-ai/fake-ai-server";
import {
  runForcedToolCallSession,
  type ForcedToolCallTool,
} from "./forced-tool-call-session";
import { logWork } from "./work-logger";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";

/**
 * Forces a single MCP tool call through a REAL OpenCode session and reports
 * whether it actually succeeded, using the production fake-LLM server
 * promoted in #107. This is the verification step behind the dry-run "health
 * check" feature: completing the MCP handshake only proves a server started,
 * not that any of its tools actually work — this proves the latter.
 *
 * Assumes {@link ForceAndVerifyMcpHealthCheckInput.fakeAiServer} is a single,
 * already-started instance the caller owns; starting/stopping it (and reusing
 * it across multiple health checks in one dry run) is the caller's
 * responsibility.
 *
 * IMPORTANT — this function does NOT redirect the agent's LLM provider at
 * anything. It assumes the OpenCode agent process at `agentBaseUrl` was
 * *launched* with the synthetic fake provider already baked into its
 * config, via the runtime environment's `fakeAiProviderOverride` ->
 * `buildFakeProviderConfig` -> `buildOpencodeContext`'s
 * `providerOverride` plumbing (see `../infra/fake-ai/fake-provider-config.ts`
 * and the two runtime-environment orchestrators). That is a deliberate
 * change from an earlier approach: this function used to PATCH `/config`
 * (and set an `/auth` credential) on the already-running agent immediately
 * before forcing the health check prompt, then revert both in a `finally`
 * block. That was proven to have ZERO live effect (see #109) — OpenCode reads
 * provider config once at process startup and does not react to `config.update`
 * calls on a running agent, so the "fake" provider override was silently
 * ignored and the health check prompt was actually going to whatever provider
 * the agent booted with. Do not reintroduce a call-time `/config` or `/auth`
 * PATCH here; it is a proven dead end. If a future health check needs a
 * *different* fake-provider target than the one the agent launched with, the
 * only way to make that live is to relaunch the agent with a new
 * `fakeAiProviderOverride`, not to patch the running one.
 */

const DEFAULT_HEALTH_CHECK_POLL_INTERVAL_MS = 500;

/**
 * The qualified `{tool, args}` call to force, with `tool` already qualified as
 * `${serverName}_${toolName}` per OpenCode's MCP tool naming when the caller's
 * check names an `mcp` server, or used verbatim for a flat plugin/standalone
 * tool id.
 */
export type McpHealthCheckCall = {
  tool: string;
  args: Record<string, unknown>;
};

export type ForceAndVerifyMcpHealthCheckInput = {
  server: OpencodeServerHandle;
  /** The qualified `{tool, args}` call to force. */
  healthCheck: McpHealthCheckCall;
  /** Already started; this function only calls `.configure()` on it. */
  fakeAiServer: FakeAiServer;
  /** The agent whose MCP tools are enabled. Defaults to `TASK_AGENT` ("build"). */
  agent?: string | undefined;
  /** Timeout for the whole forced call. */
  timeoutMs: number;
  /** Poll interval while waiting for the tool result. Defaults to 500ms. */
  pollIntervalMs?: number | undefined;
};

export type McpHealthCheckVerification =
  | { passed: true }
  | {
      passed: false;
      /**
       * `tool-error` — the MCP tool call itself failed (the underlying MCP
       * error is in `detail`). `timeout` — it never resolved within the
       * timeout. `session-error` — something went wrong orchestrating the
       * OpenCode session itself (not the MCP server's fault); this covers both
       * a thrown client error and a session turn that failed at the provider
       * level (e.g. a `provider.auth` error), which would otherwise masquerade
       * as a `timeout`.
       */
      reason: "tool-error" | "timeout" | "session-error";
      detail: string;
    };

function judgeMcpToolCall(
  tool: ForcedToolCallTool,
): McpHealthCheckVerification | undefined {
  switch (tool.state.status) {
    case "completed":
      return { passed: true };
    case "error":
      return {
        passed: false,
        reason: "tool-error",
        detail: tool.state.error.message,
      };
    default:
      return undefined;
  }
}

export async function forceAndVerifyMcpHealthCheck(
  input: ForceAndVerifyMcpHealthCheckInput,
): Promise<McpHealthCheckVerification> {
  const { server, healthCheck, fakeAiServer } = input;

  logWork("mcp-health-check", "Forcing MCP health check tool call", {
    agentBaseUrl: server.baseUrl,
    tool: healthCheck.tool,
  });

  // `runHealthChecks` (worker) may run several checks concurrently against
  // this same `fakeAiServer` instance (parallel lanes, one per
  // `serialGroup`/ungrouped check — see `run-health-checks.ts`), so the
  // forced tool/args are embedded directly in the prompt text via
  // `buildForcedToolCallPrompt` rather than relied on from `configure()`:
  // that keeps each request self-describing instead of racing other
  // in-flight checks over `fakeAiServer`'s shared mutable
  // `forcedToolCall` field. `configure()` is still called too, purely as a
  // fallback for the (non-concurrent) case an older `FakeAiServer` build
  // doesn't parse the marker — see `fake-ai-server.ts`.
  fakeAiServer.configure(healthCheck.tool, healthCheck.args);

  return runForcedToolCallSession({
    server,
    title: `boboddy-mcp-health-check:${healthCheck.tool}`,
    agent: input.agent ?? TASK_AGENT,
    tool: healthCheck.tool,
    args: healthCheck.args,
    judge: judgeMcpToolCall,
    timeoutMs: input.timeoutMs,
    pollIntervalMs:
      input.pollIntervalMs ?? DEFAULT_HEALTH_CHECK_POLL_INTERVAL_MS,
    logScope: "mcp-health-check",
  });
}
