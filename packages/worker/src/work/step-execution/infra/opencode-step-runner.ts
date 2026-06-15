import type { SessionStatus } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { StepExecutionAgentRunner } from "../contracts/process-project-work-types";
import { logWork } from "../application/work-logger";

export type PromptAsyncOpencodeStepInput = {
  aiBaseUrl: string;
  sessionTitle: string;
  promptText: string;
  agent: string;
};

export type PromptAsyncOpencodeStepResult = {
  sessionId: string;
};

export type OpencodeStepRunner = StepExecutionAgentRunner;

const DEFAULT_DIRECTORY = "/workspace";

/** Max attempts for the initial session.create call (1 original + retries). */
const SESSION_CREATE_MAX_ATTEMPTS = 5;
/** Base back-off delay in ms; doubles on each retry (100, 200, 400, 800 …). */
const SESSION_CREATE_BACKOFF_BASE_MS = 100;

function createClient(aiBaseUrl: string) {
  return createOpencodeClient({
    baseUrl: aiBaseUrl,
    directory: DEFAULT_DIRECTORY,
  });
}

/**
 * The OpenCode server logs "opencode server listening on" when it binds the
 * port, but on slow runners (e.g. CI Linux) the HTTP stack may not be ready
 * to handle the very first request before that log line appears. Retry the
 * initial session.create call a handful of times with exponential back-off to
 * absorb that small window.
 */
async function createSessionWithRetry(
  client: ReturnType<typeof createClient>,
  title: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_CREATE_MAX_ATTEMPTS; attempt++) {
    try {
      const sessionResponse = await client.session.create({
        body: { title },
      });
      const sessionId = sessionResponse.data?.id;
      if (!sessionId) {
        throw new Error("OpenCode did not return a session id");
      }
      return sessionId;
    } catch (error) {
      lastError = error;
      if (attempt < SESSION_CREATE_MAX_ATTEMPTS) {
        const delayMs = SESSION_CREATE_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function isRunningSessionStatus(sessionStatus: SessionStatus | undefined): boolean {
  if (!sessionStatus) {
    return false;
  }

  if (sessionStatus.type === "busy" || sessionStatus.type === "retry") {
    return true;
  }

  return false;
}

/**
 * When opencode is retrying an upstream AI request it reports a `retry` status
 * carrying the provider's error message (e.g. an OpenAI `server_error` with its
 * request id) and the current attempt count. Pull those out so the worker can
 * log AI-provider failures as a distinct, actionable signal.
 */
function extractProviderError(
  sessionStatus: SessionStatus | undefined,
): { attempt: number; message: string } | undefined {
  if (!sessionStatus || sessionStatus.type !== "retry") {
    return undefined;
  }

  const message =
    typeof sessionStatus.message === "string" ? sessionStatus.message : "";
  if (!message) {
    return undefined;
  }

  const attempt =
    typeof sessionStatus.attempt === "number" ? sessionStatus.attempt : 0;

  return { attempt, message };
}

export class DefaultOpencodeStepRunner implements OpencodeStepRunner {
  async promptAsync(
    input: PromptAsyncOpencodeStepInput,
  ): Promise<PromptAsyncOpencodeStepResult> {
    logWork("opencode", "Creating OpenCode client", {
      aiBaseUrl: input.aiBaseUrl,
      sessionTitle: input.sessionTitle,
    });
    const client = createClient(input.aiBaseUrl);
    const sessionId = await createSessionWithRetry(client, input.sessionTitle);

    logWork("opencode", "Created OpenCode session", {
      sessionId,
      sessionTitle: input.sessionTitle,
    });

    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        agent: input.agent,
        parts: [
          {
            type: "text",
            text: input.promptText,
          },
        ],
      },
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
    aiBaseUrl: string;
    sessionId: string;
  }): Promise<{
    running: boolean;
    providerError?: { attempt: number; message: string } | undefined;
  }> {
    const client = createClient(input.aiBaseUrl);
    logWork("opencode", "Checking OpenCode session status", {
      aiBaseUrl: input.aiBaseUrl,
      sessionId: input.sessionId,
    });

    const statusResponse = await client.session.status();
    const statusBySession = statusResponse.data ?? {};
    const rawSessionStatus = statusBySession[input.sessionId];
    const running = isRunningSessionStatus(rawSessionStatus);
    const providerError = extractProviderError(rawSessionStatus);
    logWork("opencode", "Resolved OpenCode session status", {
      sessionId: input.sessionId,
      running,
      rawSessionStatus,
    });
    return { running, providerError };
  }

  async sendRetryPrompt(input: {
    aiBaseUrl: string;
    sessionId: string;
    promptText: string;
    agent: string;
  }): Promise<void> {
    const client = createClient(input.aiBaseUrl);
    logWork("opencode", "Sending retry prompt to OpenCode session", {
      aiBaseUrl: input.aiBaseUrl,
      sessionId: input.sessionId,
      promptLength: input.promptText.length,
    });
    await client.session.promptAsync({
      path: { id: input.sessionId },
      body: {
        agent: input.agent,
        parts: [
          {
            type: "text",
            text: input.promptText,
          },
        ],
      },
    });
  }
}
