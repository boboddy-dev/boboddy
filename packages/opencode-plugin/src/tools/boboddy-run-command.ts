import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import {
  assertWorkspaceReadable,
  toRuntimeResponseJson,
  waitForRuntimeResponse,
  writeRuntimeRequest,
} from "./_shared/runtime-request";
import { resolveWorktree } from "./_shared/resolve-worktree";

const POLL_INTERVAL_MS = 250;

const boboddyRunCommand: ToolDefinition = tool({
  description:
    "Run any shell command inside the devcontainer. Returns full stdout and stderr output. For long-running processes like dev servers, returns partial output after timeoutSeconds and provides a commandId for later cancellation via boboddy-cancel-command.",
  args: {
    command: tool.schema
      .string()
      .describe("Shell command to run, e.g. 'bun run typecheck'"),
    dir: tool.schema
      .string()
      .describe(
        "Working directory as a relative path from workspace root, e.g. 'apps/web'",
      ),
    // timeoutSeconds: tool.schema
    //   .number()
    //   .describe(
    //     "Seconds to wait before returning. If the process exits first, returns immediately with full output. If still running at the timeout, returns partial output with status 'running' — the process keeps running. Use a short value (e.g. 5) for dev servers; a longer value for slow commands like typechecks.",
    //   ),
  },
  async execute(args, context) {
    const workspacePath = await resolveWorktree(context.worktree);
    await assertWorkspaceReadable(workspacePath);
    const requestId = crypto.randomUUID();
    await writeRuntimeRequest({
      workspacePath,
      request: {
        id: requestId,
        kind: "run_arbitrary_command",
        command: args.command,
        dir: args.dir,
        // timeoutMs: args.timeoutSeconds * 1000,
        timeoutMs: 10 * 1000,
      },
    });

    return toRuntimeResponseJson(
      await waitForRuntimeResponse({
        workspacePath,
        requestId,
        // timeoutMs: args.timeoutSeconds * 1000 + 10_000,
        timeoutMs: 10 * 1000 + 10_000,
        pollIntervalMs: POLL_INTERVAL_MS,
        timeoutMessage:
          "Timed out waiting for Boboddy runtime command response from the local worker.",
      }),
    );
  },
});

export default boboddyRunCommand;
