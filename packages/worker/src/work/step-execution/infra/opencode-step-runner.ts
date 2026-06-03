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

function createClient(aiBaseUrl: string) {
  return createOpencodeClient({
    baseUrl: aiBaseUrl,
    directory: DEFAULT_DIRECTORY,
  });
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

export class DefaultOpencodeStepRunner implements OpencodeStepRunner {
  async promptAsync(
    input: PromptAsyncOpencodeStepInput,
  ): Promise<PromptAsyncOpencodeStepResult> {
    logWork("opencode", "Creating OpenCode client", {
      aiBaseUrl: input.aiBaseUrl,
      sessionTitle: input.sessionTitle,
    });
    const client = createClient(input.aiBaseUrl);
    const sessionResponse = await client.session.create({
      body: {
        title: input.sessionTitle,
      },
    });
    const sessionId = sessionResponse.data?.id;

    if (!sessionId) {
      throw new Error("OpenCode did not return a session id");
    }

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
  }): Promise<{ running: boolean }> {
    const client = createClient(input.aiBaseUrl);
    logWork("opencode", "Checking OpenCode session status", {
      aiBaseUrl: input.aiBaseUrl,
      sessionId: input.sessionId,
    });

    const statusResponse = await client.session.status();
    const statusBySession = statusResponse.data ?? {};
    const rawSessionStatus = statusBySession[input.sessionId];
    const running = isRunningSessionStatus(rawSessionStatus);
    logWork("opencode", "Resolved OpenCode session status", {
      sessionId: input.sessionId,
      running,
      rawSessionStatus,
    });
    return { running };
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
