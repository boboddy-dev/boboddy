import type { SessionMessageAssistantRetry } from "@opencode/client";
import type {
  OpencodeServerHandle,
  TaskAgentRunner,
} from "../contracts/process-project-work-types";
import { logWork, logWorkError } from "../application/work-logger";
import {
  createBoboddyOpencodeClient,
  opencodeLocation,
  type BoboddyOpencodeClient,
} from "./opencode-client";

export type PromptAsyncOpencodeStepInput = {
  server: OpencodeServerHandle;
  sessionTitle: string;
  promptText: string;
  agent: string;
  /** See {@link TaskAgentRunner}'s `promptAsync.onSessionCreated`. */
  onSessionCreated?: (input: { sessionId: string }) => void | Promise<void>;
};

export type PromptAsyncOpencodeStepResult = {
  sessionId: string;
};

export type OpencodeStepRunner = TaskAgentRunner;

/** Max attempts for the initial session.create call (1 original + retries). */
const SESSION_CREATE_MAX_ATTEMPTS = 5;
/** Base back-off delay in ms; doubles on each retry (100, 200, 400, 800 …). */
const SESSION_CREATE_BACKOFF_BASE_MS = 100;

/**
 * The OpenCode server can pass its readiness probe a moment before every route
 * is serving on slow runners (e.g. CI Linux). Retry the initial
 * session.create call a handful of times with exponential back-off to absorb
 * that small window. The agent is fixed at creation: v2 prompts carry no
 * agent of their own.
 */
async function createSessionWithRetry(
  client: BoboddyOpencodeClient,
  input: { title: string; agent: string; server: OpencodeServerHandle },
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_CREATE_MAX_ATTEMPTS; attempt++) {
    try {
      const session = await client.session.create({
        title: input.title,
        agent: input.agent,
        location: opencodeLocation(input.server),
      });
      if (!session.id) {
        throw new Error("OpenCode did not return a session id");
      }
      return session.id;
    } catch (error) {
      lastError = error;
      const willRetry = attempt < SESSION_CREATE_MAX_ATTEMPTS;
      const delayMs = willRetry
        ? SESSION_CREATE_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
        : 0;
      // Surface every failed attempt. This call is the first request the worker
      // makes to the OpenCode server, so failures here usually mean the server
      // is not yet serving. The monitor's injected logger may be silenced in
      // tests, so we log via the always-on work logger to keep this visible in
      // CI.
      logWorkError("opencode", "OpenCode session.create attempt failed", {
        agentBaseUrl: input.server.baseUrl,
        title: input.title,
        attempt,
        maxAttempts: SESSION_CREATE_MAX_ATTEMPTS,
        willRetry,
        retryDelayMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      if (willRetry) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  logWorkError("opencode", "OpenCode session.create exhausted all attempts", {
    agentBaseUrl: input.server.baseUrl,
    title: input.title,
    maxAttempts: SESSION_CREATE_MAX_ATTEMPTS,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw lastError;
}

/**
 * While OpenCode retries an upstream AI request, the in-flight assistant
 * message carries `retry: { attempt, error: { type, message } }` (it is
 * cleared once the step settles). Surface it so the worker can log
 * AI-provider failures as a distinct, actionable signal.
 */
async function readProviderError(
  client: BoboddyOpencodeClient,
  sessionId: string,
): Promise<{ attempt: number; message: string } | undefined> {
  const page = await client.message.list({
    sessionID: sessionId,
    type: "assistant",
    order: "desc",
    limit: 1,
  });
  const latest = page.data[0];
  if (!latest || latest.type !== "assistant") {
    return undefined;
  }
  return toProviderError(latest.retry);
}

function toProviderError(
  retry: SessionMessageAssistantRetry | undefined,
): { attempt: number; message: string } | undefined {
  if (!retry?.error.message) {
    return undefined;
  }
  return { attempt: retry.attempt, message: retry.error.message };
}

export class DefaultOpencodeStepRunner implements OpencodeStepRunner {
  async promptAsync(
    input: PromptAsyncOpencodeStepInput,
  ): Promise<PromptAsyncOpencodeStepResult> {
    logWork("opencode", "Creating OpenCode client", {
      agentBaseUrl: input.server.baseUrl,
      sessionTitle: input.sessionTitle,
    });
    const client = createBoboddyOpencodeClient(input.server);
    const sessionId = await createSessionWithRetry(client, {
      title: input.sessionTitle,
      agent: input.agent,
      server: input.server,
    });

    logWork("opencode", "Created OpenCode session", {
      sessionId,
      sessionTitle: input.sessionTitle,
    });

    // Give the caller a chance to attach its conversation-event subscription
    // before the prompt goes out below — the v2 event stream is live-only with
    // no replay, so a subscriber that isn't already listening misses the
    // session's opening events.
    await input.onSessionCreated?.({ sessionId });

    await client.session.prompt({
      sessionID: sessionId,
      text: input.promptText,
    });
    logWork("opencode", "Submitted prompt to OpenCode session", {
      sessionId,
      promptLength: input.promptText.length,
    });
    return {
      sessionId,
    };
  }

  async getSessionStatus(input: {
    server: OpencodeServerHandle;
    sessionId: string;
  }): Promise<{
    running: boolean;
    providerError?: { attempt: number; message: string } | undefined;
  }> {
    const client = createBoboddyOpencodeClient(input.server);
    logWork("opencode", "Checking OpenCode session status", {
      agentBaseUrl: input.server.baseUrl,
      sessionId: input.sessionId,
    });

    const active = await client.session.active();
    const rawSessionStatus = active[input.sessionId];
    const running = rawSessionStatus !== undefined;
    const providerError = running
      ? await readProviderError(client, input.sessionId)
      : undefined;
    logWork("opencode", "Resolved OpenCode session status", {
      sessionId: input.sessionId,
      running,
      rawSessionStatus,
    });
    return running ? { running, providerError } : { running };
  }

  /**
   * Sends a follow-up prompt into the existing session. `agent` is the one the
   * session was created with; v2 prompts cannot override it.
   */
  async sendRetryPrompt(input: {
    server: OpencodeServerHandle;
    sessionId: string;
    promptText: string;
    agent: string;
  }): Promise<void> {
    const client = createBoboddyOpencodeClient(input.server);
    logWork("opencode", "Sending retry prompt to OpenCode session", {
      agentBaseUrl: input.server.baseUrl,
      sessionId: input.sessionId,
      agent: input.agent,
      promptLength: input.promptText.length,
    });
    await client.session.prompt({
      sessionID: input.sessionId,
      text: input.promptText,
    });
  }
}
