import { TASK_AGENT } from "@boboddy/opencode-plugin";
import type { FakeAiServer } from "../infra/fake-ai/fake-ai-server";
import {
  renderToolTextContent,
  runForcedToolCallSession,
  type ForcedToolCallTool,
} from "./forced-tool-call-session";
import { logWork } from "./work-logger";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";

/**
 * Forces a single `shell` tool call through a REAL OpenCode session and
 * reports whether the command it ran actually exited with the expected code —
 * the `"cli"`-kind counterpart to `forceAndVerifyMcpHealthCheck`, sharing its
 * session lifecycle (`forced-tool-call-session.ts`) and its
 * `fakeAiServer`/marker-based concurrency plumbing (see
 * `force-and-verify-mcp-health-check.ts` for why `configure()` is not enough
 * on its own when several checks share one `FakeAiServer` instance).
 *
 * The one substantive difference from the MCP verifier: OpenCode's `shell`
 * tool call always "completes" whether the command it ran succeeded or not (a
 * missing binary is just a non-zero exit code baked into its result, not a
 * tool-level error) — so `status === "completed"` is NOT sufficient here.
 *
 * Observed against a real v2.0.28 server, a completed `shell` call looks like:
 *   content:  [{ type: "text", text: "<stdout+stderr>" },
 *              { type: "text", text: "Exited with code 3" }]
 *   metadata: { status: "completed", truncated: false, exit: 3 }
 * `metadata` is an untyped JSON bag at the type level, so `exit` is read
 * defensively. The trailing "Exited with code N" item is dropped from the
 * reported output since the detail already states the exit code.
 */

const SHELL_TOOL_ID = "shell";
const DEFAULT_HEALTH_CHECK_POLL_INTERVAL_MS = 500;
const MAX_OUTPUT_DETAIL_CHARS = 2000;
const EXIT_SUMMARY_PATTERN = /^Exited with code -?\d+$/;

export type ForceAndVerifyCliHealthCheckInput = {
  server: OpencodeServerHandle;
  /** The command tokens to run, e.g. `["gh", "--version"]` — joined with a single space before being handed to the `shell` tool's single `command` string argument. */
  command: string[];
  /** The exit code that counts as a pass. */
  expectExitCode: number;
  /** Already started; this function only calls `.configure()` on it. */
  fakeAiServer: FakeAiServer;
  /** The agent whose tools are enabled. Defaults to `TASK_AGENT` ("build"). */
  agent?: string | undefined;
  /** Timeout for the whole forced call. */
  timeoutMs: number;
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
       * to catch — see the file comment). `tool-error` — the `shell` tool
       * call itself failed at the tool-invocation level (bad workdir,
       * permission denied — same bucket as the MCP verifier's `tool-error`).
       * `timeout` — it never resolved within the timeout. `session-error` —
       * something went wrong orchestrating the OpenCode session itself, not
       * the command's fault.
       */
      reason: "nonzero-exit" | "tool-error" | "timeout" | "session-error";
      detail: string;
    };

function truncateForDetail(output: string): string {
  if (output.length <= MAX_OUTPUT_DETAIL_CHARS) {
    return output;
  }
  return `${output.slice(0, MAX_OUTPUT_DETAIL_CHARS)}... (truncated)`;
}

function readShellExitCode(tool: ForcedToolCallTool): number | undefined {
  if (tool.state.status !== "completed") {
    return undefined;
  }
  const exit = tool.state.metadata?.["exit"];
  return typeof exit === "number" ? exit : undefined;
}

function readShellOutput(tool: ForcedToolCallTool): string {
  if (tool.state.status !== "completed") {
    return "";
  }
  const content = [...tool.state.content];
  const last = content.at(-1);
  if (last?.type === "text" && EXIT_SUMMARY_PATTERN.test(last.text.trim())) {
    content.pop();
  }
  return renderToolTextContent(content);
}

function judgeShellToolCall(
  expectExitCode: number,
): (tool: ForcedToolCallTool) => CliHealthCheckVerification | undefined {
  return (tool) => {
    switch (tool.state.status) {
      case "completed": {
        const exitCode = readShellExitCode(tool);
        if (exitCode === expectExitCode) {
          return { passed: true };
        }
        const actualDescription =
          exitCode === undefined
            ? "unknown (missing from tool metadata)"
            : String(exitCode);
        return {
          passed: false,
          reason: "nonzero-exit",
          detail: `Command exited with ${actualDescription}, expected ${String(expectExitCode)}. Output: ${truncateForDetail(readShellOutput(tool))}`,
        };
      }
      case "error":
        return {
          passed: false,
          reason: "tool-error",
          detail: tool.state.error.message,
        };
      default:
        return undefined;
    }
  };
}

export async function forceAndVerifyCliHealthCheck(
  input: ForceAndVerifyCliHealthCheckInput,
): Promise<CliHealthCheckVerification> {
  const { server, command, expectExitCode, fakeAiServer } = input;
  const joinedCommand = command.join(" ");
  const toolArgs = {
    command: joinedCommand,
    description: `Boboddy health check: ${joinedCommand}`,
  };

  logWork("cli-health-check", "Forcing cli health check shell call", {
    agentBaseUrl: server.baseUrl,
    command: joinedCommand,
  });

  // Mirrors `forceAndVerifyMcpHealthCheck`'s reasoning: several checks can
  // run concurrently against this same `fakeAiServer` instance, so the forced
  // tool/args travel in the prompt text and `configure()` is only a fallback.
  fakeAiServer.configure(SHELL_TOOL_ID, toolArgs);

  return runForcedToolCallSession({
    server,
    title: `boboddy-cli-health-check:${joinedCommand}`,
    agent: input.agent ?? TASK_AGENT,
    tool: SHELL_TOOL_ID,
    args: toolArgs,
    judge: judgeShellToolCall(expectExitCode),
    timeoutMs: input.timeoutMs,
    pollIntervalMs:
      input.pollIntervalMs ?? DEFAULT_HEALTH_CHECK_POLL_INTERVAL_MS,
    logScope: "cli-health-check",
  });
}
