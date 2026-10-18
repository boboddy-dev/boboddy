import type {
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionStructuredError,
  ToolContent,
} from "@opencode/client";
import { buildForcedToolCallPrompt } from "../infra/fake-ai/fake-ai-server";
import {
  FAKE_MODEL_ID,
  FAKE_PROVIDER_ID,
} from "../infra/fake-ai/fake-provider-config";
import {
  createBoboddyOpencodeClient,
  opencodeLocation,
  type BoboddyOpencodeClient,
} from "../infra/opencode-client";
import { logWorkError } from "./work-logger";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";

/**
 * The OpenCode session lifecycle shared by the forced-tool-call health check
 * verifiers (`force-and-verify-mcp-health-check.ts`,
 * `force-and-verify-cli-health-check.ts`): create a session pinned to the
 * synthetic fake provider, prompt it with a forced tool call, poll its
 * messages until the caller's judge settles on a verdict, interrupt it on
 * timeout, and remove it afterwards.
 */

const SESSION_CREATE_MAX_ATTEMPTS = 3;
const SESSION_CREATE_BACKOFF_BASE_MS = 200;

export type ForcedToolCallTool = SessionMessageAssistantTool;

export type ForcedToolCallVerdict<Failure extends string> =
  | { passed: true }
  | {
      passed: false;
      reason: Failure | "timeout" | "session-error";
      detail: string;
    };

/**
 * Inspects the tool call found in the session (if any) and returns a verdict,
 * or `undefined` to keep polling.
 */
export type ForcedToolCallJudge<Failure extends string> = (
  tool: ForcedToolCallTool,
) => ForcedToolCallVerdict<Failure> | undefined;

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeStructuredError(error: SessionStructuredError): string {
  return `${error.type}: ${error.message}`;
}

export function renderToolTextContent(
  content: ReadonlyArray<ToolContent> | undefined,
): string {
  return (content ?? [])
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findTool(
  messages: SessionMessageInfo[],
  toolName: string,
): ForcedToolCallTool | undefined {
  for (const message of messages) {
    if (message.type !== "assistant") {
      continue;
    }
    for (const item of message.content) {
      if (item.type === "tool" && item.name === toolName) {
        return item;
      }
    }
  }
  return undefined;
}

/**
 * Finds the first failure of the session turn itself: an assistant step that
 * errored, or an idle marker whose execution failed (e.g. an unknown agent,
 * which never produces an assistant message at all).
 *
 * `aborted` assistant errors and `interrupted` idle markers are ignored: the
 * caller interrupts the session itself once its deadline passes, so reporting
 * that as the *cause* of the failure would be circular.
 */
function findSessionError(
  messages: SessionMessageInfo[],
): SessionStructuredError | undefined {
  for (const message of messages) {
    if (
      message.type === "assistant" &&
      message.error &&
      message.error.type !== "aborted"
    ) {
      return message.error;
    }
    if (message.type === "idle" && message.outcome === "failed") {
      return (
        message.error ?? {
          type: "unknown",
          message: "The session execution failed",
        }
      );
    }
  }
  return undefined;
}

async function createSession(
  client: BoboddyOpencodeClient,
  input: {
    server: OpencodeServerHandle;
    title: string;
    agent: string;
    logScope: string;
  },
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_CREATE_MAX_ATTEMPTS; attempt++) {
    try {
      const session = await client.session.create({
        title: input.title,
        agent: input.agent,
        model: { id: FAKE_MODEL_ID, providerID: FAKE_PROVIDER_ID },
        location: opencodeLocation(input.server),
      });
      if (!session.id) {
        throw new Error("OpenCode did not return a session id");
      }
      return session.id;
    } catch (error) {
      lastError = error;
      const willRetry = attempt < SESSION_CREATE_MAX_ATTEMPTS;
      logWorkError(input.logScope, "OpenCode session.create attempt failed", {
        agentBaseUrl: input.server.baseUrl,
        title: input.title,
        attempt,
        maxAttempts: SESSION_CREATE_MAX_ATTEMPTS,
        willRetry,
        error: errorMessage(error),
      });
      if (willRetry) {
        await sleep(SESSION_CREATE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function interruptSession(
  client: BoboddyOpencodeClient,
  sessionId: string,
  input: { agentBaseUrl: string; logScope: string },
): Promise<void> {
  try {
    await client.session.interrupt({ sessionID: sessionId });
  } catch (error) {
    logWorkError(
      input.logScope,
      "Failed to interrupt a timed-out health check session",
      {
        agentBaseUrl: input.agentBaseUrl,
        sessionId,
        error: errorMessage(error),
      },
    );
  }
}

async function removeSession(
  client: BoboddyOpencodeClient,
  sessionId: string,
  input: { agentBaseUrl: string; logScope: string },
): Promise<void> {
  try {
    await client.session.remove({ sessionID: sessionId });
  } catch (error) {
    logWorkError(input.logScope, "Failed to delete the health check session", {
      agentBaseUrl: input.agentBaseUrl,
      sessionId,
      error: errorMessage(error),
    });
  }
}

async function pollForVerdict<Failure extends string>(input: {
  client: BoboddyOpencodeClient;
  sessionId: string;
  tool: string;
  judge: ForcedToolCallJudge<Failure>;
  timeoutMs: number;
  pollIntervalMs: number;
  agentBaseUrl: string;
  logScope: string;
}): Promise<ForcedToolCallVerdict<Failure>> {
  const { client, sessionId, tool, judge, agentBaseUrl, logScope } = input;
  const deadline = Date.now() + input.timeoutMs;

  for (;;) {
    try {
      const page = await client.message.list({ sessionID: sessionId });
      const messages = page.data;

      // The tool call is judged FIRST: once it settles, its verdict stands
      // even if a later step of the turn errored.
      const toolCall = findTool(messages, tool);
      const verdict = toolCall ? judge(toolCall) : undefined;
      if (verdict) {
        return verdict;
      }

      const sessionError = findSessionError(messages);
      if (sessionError) {
        const detail = describeStructuredError(sessionError);
        logWorkError(
          logScope,
          "The health check OpenCode session failed before the tool call settled",
          { agentBaseUrl, sessionId, tool, error: detail },
        );
        return { passed: false, reason: "session-error", detail };
      }
    } catch (error) {
      logWorkError(
        logScope,
        "Failed to read session messages while polling for the health check result",
        { agentBaseUrl, sessionId, error: errorMessage(error) },
      );
    }

    if (Date.now() >= deadline) {
      await interruptSession(client, sessionId, { agentBaseUrl, logScope });
      const timeoutSeconds = Math.round(input.timeoutMs / 1000);
      return {
        passed: false,
        reason: "timeout",
        detail: `timed out after ${String(timeoutSeconds)}s`,
      };
    }

    await sleep(input.pollIntervalMs);
  }
}

/**
 * Runs one forced tool call end to end and returns the judge's verdict. Any
 * thrown orchestration error becomes a `session-error`; the session is always
 * removed afterwards.
 */
export async function runForcedToolCallSession<Failure extends string>(input: {
  server: OpencodeServerHandle;
  title: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  judge: ForcedToolCallJudge<Failure>;
  timeoutMs: number;
  pollIntervalMs: number;
  logScope: string;
}): Promise<ForcedToolCallVerdict<Failure>> {
  const { server, logScope } = input;
  const agentBaseUrl = server.baseUrl;
  const client = createBoboddyOpencodeClient(server);
  let sessionId: string | undefined;

  try {
    sessionId = await createSession(client, {
      server,
      title: input.title,
      agent: input.agent,
      logScope,
    });

    await client.session.prompt({
      sessionID: sessionId,
      text: buildForcedToolCallPrompt(input.tool, input.args),
    });

    return await pollForVerdict({
      client,
      sessionId,
      tool: input.tool,
      judge: input.judge,
      timeoutMs: input.timeoutMs,
      pollIntervalMs: input.pollIntervalMs,
      agentBaseUrl,
      logScope,
    });
  } catch (error) {
    const detail = errorMessage(error);
    logWorkError(
      logScope,
      "Failed to force-and-verify the health check tool call",
      {
        agentBaseUrl,
        tool: input.tool,
        error: detail,
      },
    );
    return { passed: false, reason: "session-error", detail };
  } finally {
    if (sessionId) {
      await removeSession(client, sessionId, { agentBaseUrl, logScope });
    }
  }
}
