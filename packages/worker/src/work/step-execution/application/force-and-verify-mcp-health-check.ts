import type {
  AssistantMessage,
  Message,
  Part,
  ToolPart,
} from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { STEP_EXECUTION_AGENT } from "@boboddy/opencode-plugin";
import type { FakeAiServer } from "../infra/fake-ai/fake-ai-server";
import {
  FAKE_MODEL_ID,
  FAKE_PROVIDER_ID,
} from "../infra/fake-ai/fake-provider-config";
import { logWork, logWorkError } from "./work-logger";

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

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_CHECK_POLL_INTERVAL_MS = 500;

/** Max attempts for the session.create call. */
const SESSION_CREATE_MAX_ATTEMPTS = 3;
const SESSION_CREATE_BACKOFF_BASE_MS = 200;

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
  agentBaseUrl: string;
  workspaceFolder: string;
  /** The qualified `{tool, args}` call to force. */
  healthCheck: McpHealthCheckCall;
  /** Already started; this function only calls `.configure()` on it. */
  fakeAiServer: FakeAiServer;
  /** The agent whose MCP tools are enabled. Defaults to `STEP_EXECUTION_AGENT` ("build"). */
  agent?: string | undefined;
  /** Fixed timeout for the whole forced call. Defaults to 30s per the ticket. */
  timeoutMs?: number | undefined;
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
       * a thrown client error and an assistant message whose turn failed at
       * the provider level (e.g. `ProviderAuthError`), which would otherwise
       * masquerade as a `timeout`.
       */
      reason: "tool-error" | "timeout" | "session-error";
      detail: string;
    };

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createClient(agentBaseUrl: string, workspaceFolder: string) {
  return createOpencodeClient({
    baseUrl: agentBaseUrl,
    directory: workspaceFolder,
  });
}

async function createHealthCheckSession(
  client: ReturnType<typeof createClient>,
  title: string,
  agentBaseUrl: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_CREATE_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.session.create({ body: { title } });
      const sessionId = response.data?.id;
      if (!sessionId) {
        throw new Error("OpenCode did not return a session id");
      }
      return sessionId;
    } catch (error) {
      lastError = error;
      const willRetry = attempt < SESSION_CREATE_MAX_ATTEMPTS;
      logWorkError(
        "mcp-health-check",
        "OpenCode session.create attempt failed",
        {
          agentBaseUrl,
          title,
          attempt,
          maxAttempts: SESSION_CREATE_MAX_ATTEMPTS,
          willRetry,
          error: errorMessage(error),
        },
      );
      if (willRetry) {
        await sleep(SESSION_CREATE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function abortHealthCheckSession(
  client: ReturnType<typeof createClient>,
  sessionId: string,
  agentBaseUrl: string,
): Promise<void> {
  try {
    await client.session.abort({ path: { id: sessionId } });
  } catch (error) {
    logWorkError(
      "mcp-health-check",
      "Failed to abort a timed-out health check session",
      {
        agentBaseUrl,
        sessionId,
        error: errorMessage(error),
      },
    );
  }
}

async function deleteHealthCheckSession(
  client: ReturnType<typeof createClient>,
  sessionId: string,
  agentBaseUrl: string,
): Promise<void> {
  try {
    await client.session.delete({ path: { id: sessionId } });
  } catch (error) {
    logWorkError(
      "mcp-health-check",
      "Failed to delete the health check session",
      {
        agentBaseUrl,
        sessionId,
        error: errorMessage(error),
      },
    );
  }
}

function findQualifiedToolPart(
  messages: Array<{ info: Message; parts: Part[] }>,
  qualifiedTool: string,
): ToolPart | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.tool === qualifiedTool) {
        return part;
      }
    }
  }
  return undefined;
}

type AssistantMessageError = NonNullable<AssistantMessage["error"]>;

/**
 * Renders an assistant-message error for a human reading the dry-run report.
 *
 * Two SDK footguns are handled explicitly here rather than by reading
 * `error.data.message` blindly:
 *  - `MessageOutputLengthError.data` is an open record with no `message`.
 *  - `ApiError`'s discriminant literal is `"APIError"`, not `"ApiError"`.
 */
function describeAssistantMessageError(error: AssistantMessageError): string {
  switch (error.name) {
    case "ProviderAuthError":
    case "UnknownError":
    case "MessageAbortedError":
    case "APIError":
      return `${error.name}: ${error.data.message}`;
    case "MessageOutputLengthError":
      return error.name;
  }
}

/**
 * Finds the first assistant message whose turn failed outright.
 *
 * `MessageAbortedError` is deliberately ignored: {@link abortHealthCheckSession}
 * aborts the session ourselves once the deadline passes, so reporting an abort
 * as the *cause* of the failure would be circular.
 */
function findAssistantMessageError(
  messages: Array<{ info: Message; parts: Part[] }>,
): AssistantMessageError | undefined {
  for (const { info } of messages) {
    if (info.role !== "assistant") {
      continue;
    }
    const { error } = info;
    if (error && error.name !== "MessageAbortedError") {
      return error;
    }
  }
  return undefined;
}

async function pollForHealthCheckResult(input: {
  client: ReturnType<typeof createClient>;
  sessionId: string;
  qualifiedTool: string;
  timeoutMs: number;
  pollIntervalMs: number;
  agentBaseUrl: string;
}): Promise<McpHealthCheckVerification> {
  const {
    client,
    sessionId,
    qualifiedTool,
    timeoutMs,
    pollIntervalMs,
    agentBaseUrl,
  } = input;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const response = await client.session.messages({
        path: { id: sessionId },
      });
      const messages = response.data ?? [];

      // The tool part is checked FIRST: if the call reached "completed" the
      // health check passed, even if a later turn errored.
      const toolPart = findQualifiedToolPart(messages, qualifiedTool);
      if (toolPart) {
        if (toolPart.state.status === "completed") {
          return { passed: true };
        }
        if (toolPart.state.status === "error") {
          return {
            passed: false,
            reason: "tool-error",
            detail: toolPart.state.error,
          };
        }
        // "pending" / "running" — fall through to the session-error check.
      }

      // No usable tool result yet. If the session itself failed at the provider
      // level, say so now instead of waiting out the timeout and blaming the
      // MCP server.
      const assistantError = findAssistantMessageError(messages);
      if (assistantError) {
        const detail = describeAssistantMessageError(assistantError);
        logWorkError(
          "mcp-health-check",
          "The health check OpenCode session failed at the assistant-message level",
          {
            agentBaseUrl,
            sessionId,
            tool: qualifiedTool,
            error: detail,
          },
        );
        return { passed: false, reason: "session-error", detail };
      }
    } catch (error) {
      logWorkError(
        "mcp-health-check",
        "Failed to read session messages while polling for the health check result",
        {
          agentBaseUrl,
          sessionId,
          error: errorMessage(error),
        },
      );
    }

    if (Date.now() >= deadline) {
      await abortHealthCheckSession(client, sessionId, agentBaseUrl);
      const timeoutSeconds = Math.round(timeoutMs / 1000);
      return {
        passed: false,
        reason: "timeout",
        detail: `timed out after ${String(timeoutSeconds)}s`,
      };
    }

    await sleep(pollIntervalMs);
  }
}

export async function forceAndVerifyMcpHealthCheck(
  input: ForceAndVerifyMcpHealthCheckInput,
): Promise<McpHealthCheckVerification> {
  const { agentBaseUrl, workspaceFolder, healthCheck, fakeAiServer } = input;
  const client = createClient(agentBaseUrl, workspaceFolder);
  const timeoutMs = input.timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const pollIntervalMs =
    input.pollIntervalMs ?? DEFAULT_HEALTH_CHECK_POLL_INTERVAL_MS;
  const agent = input.agent ?? STEP_EXECUTION_AGENT;

  logWork("mcp-health-check", "Forcing MCP health check tool call", {
    agentBaseUrl,
    tool: healthCheck.tool,
  });

  let sessionId: string | undefined;

  try {
    fakeAiServer.configure(healthCheck.tool, healthCheck.args);

    sessionId = await createHealthCheckSession(
      client,
      `boboddy-mcp-health-check:${healthCheck.tool}`,
      agentBaseUrl,
    );

    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        agent,
        model: { providerID: FAKE_PROVIDER_ID, modelID: FAKE_MODEL_ID },
        parts: [
          {
            type: "text",
            text: `Call the ${healthCheck.tool} tool to verify it works.`,
          },
        ],
      },
    });

    return await pollForHealthCheckResult({
      client,
      sessionId,
      qualifiedTool: healthCheck.tool,
      timeoutMs,
      pollIntervalMs,
      agentBaseUrl,
    });
  } catch (error) {
    const detail = errorMessage(error);
    logWorkError(
      "mcp-health-check",
      "Failed to force-and-verify the MCP health check tool call",
      {
        agentBaseUrl,
        tool: healthCheck.tool,
        error: detail,
      },
    );
    return { passed: false, reason: "session-error", detail };
  } finally {
    if (sessionId) {
      await deleteHealthCheckSession(client, sessionId, agentBaseUrl);
    }
  }
}
