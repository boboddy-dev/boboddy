import type {
  AssistantMessage,
  Message,
  Part,
  ToolPart,
} from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { STEP_EXECUTION_AGENT } from "@boboddy/opencode-plugin";
import {
  buildForcedToolCallPrompt,
  type FakeAiServer,
} from "../infra/fake-ai/fake-ai-server";
import {
  FAKE_MODEL_ID,
  FAKE_PROVIDER_ID,
} from "../infra/fake-ai/fake-provider-config";
import { logWork, logWorkError } from "./work-logger";

/**
 * Forces a single `bash` tool call through a REAL OpenCode session and reports
 * whether the command it ran actually exited with the expected code — the
 * `"cli"`-kind counterpart to `forceAndVerifyMcpHealthCheck`, sharing its
 * session lifecycle (create → force call → poll → delete) and its
 * `fakeAiServer`/marker-based concurrency plumbing (see that file's top
 * comment for why `configure()` is not enough on its own when several checks
 * share one `FakeAiServer` instance).
 *
 * The one substantive difference from the MCP verifier: OpenCode's `bash`
 * tool call always "completes" whether the command it ran succeeded or not
 * (a missing binary is just a non-zero exit code baked into its result, not a
 * tool-level error) — so unlike the MCP verifier, `status === "completed"` is
 * NOT sufficient here. This function reads the real exit code back out of the
 * tool result and compares it against `expectExitCode`; see the Phase-1
 * finding below for exactly where that lives.
 */

/**
 * A completed `bash` tool call's `ToolPart.state.metadata` is an untyped
 * `{[key:string]: unknown}` bag per `@opencode-ai/sdk`'s generated types, but
 * its REAL runtime shape — confirmed both from OpenCode's own bash-tool
 * source (`packages/core/src/tool/bash.ts` in the opencode repo) and from
 * live session data captured on disk (`~/.local/share/opencode/opencode.db`,
 * `part` table) at v1.18.x — is:
 *   { exit: number; output: string; truncated: boolean }
 * `output` is stdout+stderr COMBINED (the tool runs with
 * `combineOutput: true`); there is no separate stdout/stderr field. A
 * command that doesn't exist (e.g. exit 127) still reaches
 * `status: "completed"` with `exit: 127` in metadata — the bug this
 * verifier exists to fix. A genuine timeout sets `metadata.timeout: true`
 * and omits `exit`. Read `exit` defensively (it's still `unknown` at the
 * type level) rather than trusting `status === "completed"` alone.
 */
function readBashExitCode(metadata: {
  [key: string]: unknown;
}): number | undefined {
  const exit = metadata["exit"];
  return typeof exit === "number" ? exit : undefined;
}

function readBashOutput(
  metadata: { [key: string]: unknown },
  fallback: string,
): string {
  const output = metadata["output"];
  return typeof output === "string" ? output : fallback;
}

const BASH_TOOL_ID = "bash";
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_CHECK_POLL_INTERVAL_MS = 500;
const MAX_OUTPUT_DETAIL_CHARS = 2000;

/** Max attempts for the session.create call. */
const SESSION_CREATE_MAX_ATTEMPTS = 3;
const SESSION_CREATE_BACKOFF_BASE_MS = 200;

export type ForceAndVerifyCliHealthCheckInput = {
  agentBaseUrl: string;
  workspaceFolder: string;
  /** The command tokens to run, e.g. `["gh", "--version"]` — joined with a single space before being handed to the `bash` tool's single `command` string argument. */
  command: string[];
  /** The exit code that counts as a pass. */
  expectExitCode: number;
  /** Already started; this function only calls `.configure()` on it. */
  fakeAiServer: FakeAiServer;
  /** The agent whose tools are enabled. Defaults to `STEP_EXECUTION_AGENT` ("build"). */
  agent?: string | undefined;
  /** Fixed timeout for the whole forced call. Defaults to 30s, matching the MCP verifier. */
  timeoutMs?: number | undefined;
  /** Poll interval while waiting for the tool result. Defaults to 500ms. */
  pollIntervalMs?: number | undefined;
};

export type CliHealthCheckVerification =
  | { passed: true }
  | {
      passed: false;
      /**
       * `nonzero-exit` — the command ran and completed, but its exit code
       * didn't match `expectExitCode` (this is the bug this verifier exists
       * to catch — see the file comment). `tool-error` — the `bash` tool
       * call itself failed at the tool-invocation level (bad workdir,
       * permission denied — same bucket as the MCP verifier's `tool-error`).
       * `timeout` — it never resolved within the timeout. `session-error` —
       * something went wrong orchestrating the OpenCode session itself, not
       * the command's fault.
       */
      reason: "nonzero-exit" | "tool-error" | "timeout" | "session-error";
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

function truncateForDetail(output: string): string {
  if (output.length <= MAX_OUTPUT_DETAIL_CHARS) {
    return output;
  }
  return `${output.slice(0, MAX_OUTPUT_DETAIL_CHARS)}... (truncated)`;
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
        "cli-health-check",
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
      "cli-health-check",
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
      "cli-health-check",
      "Failed to delete the health check session",
      {
        agentBaseUrl,
        sessionId,
        error: errorMessage(error),
      },
    );
  }
}

function findBashToolPart(
  messages: Array<{ info: Message; parts: Part[] }>,
): ToolPart | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.tool === BASH_TOOL_ID) {
        return part;
      }
    }
  }
  return undefined;
}

type AssistantMessageError = NonNullable<AssistantMessage["error"]>;

/**
 * Renders an assistant-message error for a human reading the dry-run report.
 * Mirrors `force-and-verify-mcp-health-check.ts`'s `describeAssistantMessageError`
 * — see that file for why the two SDK footguns (`MessageOutputLengthError`'s
 * shape, `APIError`'s discriminant literal) are handled explicitly.
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
  expectExitCode: number;
  timeoutMs: number;
  pollIntervalMs: number;
  agentBaseUrl: string;
}): Promise<CliHealthCheckVerification> {
  const {
    client,
    sessionId,
    expectExitCode,
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

      // The tool part is checked FIRST: a "completed" bash call is only a
      // pass if its exit code also matches — see the Phase-1 finding above.
      const toolPart = findBashToolPart(messages);
      if (toolPart) {
        if (toolPart.state.status === "completed") {
          const exitCode = readBashExitCode(toolPart.state.metadata);
          if (exitCode === expectExitCode) {
            return { passed: true };
          }
          const output = readBashOutput(
            toolPart.state.metadata,
            toolPart.state.output,
          );
          const actualDescription =
            exitCode === undefined
              ? "unknown (missing from tool metadata)"
              : String(exitCode);
          return {
            passed: false,
            reason: "nonzero-exit",
            detail: `Command exited with ${actualDescription}, expected ${String(expectExitCode)}. Output: ${truncateForDetail(output)}`,
          };
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

      // No usable tool result yet. If the session itself failed at the
      // provider level, say so now instead of waiting out the timeout and
      // blaming the command.
      const assistantError = findAssistantMessageError(messages);
      if (assistantError) {
        const detail = describeAssistantMessageError(assistantError);
        logWorkError(
          "cli-health-check",
          "The health check OpenCode session failed at the assistant-message level",
          {
            agentBaseUrl,
            sessionId,
            error: detail,
          },
        );
        return { passed: false, reason: "session-error", detail };
      }
    } catch (error) {
      logWorkError(
        "cli-health-check",
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

export async function forceAndVerifyCliHealthCheck(
  input: ForceAndVerifyCliHealthCheckInput,
): Promise<CliHealthCheckVerification> {
  const {
    agentBaseUrl,
    workspaceFolder,
    command,
    expectExitCode,
    fakeAiServer,
  } = input;
  const client = createClient(agentBaseUrl, workspaceFolder);
  const timeoutMs = input.timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const pollIntervalMs =
    input.pollIntervalMs ?? DEFAULT_HEALTH_CHECK_POLL_INTERVAL_MS;
  const agent = input.agent ?? STEP_EXECUTION_AGENT;
  const joinedCommand = command.join(" ");
  const toolArgs = { command: joinedCommand };

  logWork("cli-health-check", "Forcing cli health check bash call", {
    agentBaseUrl,
    command: joinedCommand,
  });

  let sessionId: string | undefined;

  try {
    // Mirrors `forceAndVerifyMcpHealthCheck`'s reasoning: several checks can
    // run concurrently against this same `fakeAiServer` instance (parallel
    // lanes — see `run-health-checks.ts`), so the forced tool/args are
    // embedded directly in the prompt text via `buildForcedToolCallPrompt`
    // rather than relied on from `configure()`. `configure()` is still called
    // too, purely as a fallback for the (non-concurrent) case an older
    // `FakeAiServer` build doesn't parse the marker.
    fakeAiServer.configure(BASH_TOOL_ID, toolArgs);

    sessionId = await createHealthCheckSession(
      client,
      `boboddy-cli-health-check:${joinedCommand}`,
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
            text: buildForcedToolCallPrompt(BASH_TOOL_ID, toolArgs),
          },
        ],
      },
    });

    return await pollForHealthCheckResult({
      client,
      sessionId,
      expectExitCode,
      timeoutMs,
      pollIntervalMs,
      agentBaseUrl,
    });
  } catch (error) {
    const detail = errorMessage(error);
    logWorkError(
      "cli-health-check",
      "Failed to force-and-verify the cli health check bash call",
      {
        agentBaseUrl,
        command: joinedCommand,
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
