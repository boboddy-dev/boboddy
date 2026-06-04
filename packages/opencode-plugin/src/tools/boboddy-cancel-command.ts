import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import {
  assertWorkspaceReadable,
  toRuntimeResponseJson,
  waitForRuntimeResponse,
  writeRuntimeRequest,
} from "./_shared/runtime-request";
import { resolveWorktree } from "./_shared/resolve-worktree";

const POLL_INTERVAL_MS = 250;
const TIMEOUT_MS = 10_000;

const boboddyCancelCommand: ToolDefinition = tool({
  description:
    "Cancel a running command that was started with boboddy-run-command. Use the commandId from the boboddy-run-command response.",
  args: {
    commandId: tool.schema
      .string()
      .describe("The commandId returned in the boboddy-run-command response"),
  },
  async execute(args, context) {
    const workspacePath = await resolveWorktree(context.worktree);
    await assertWorkspaceReadable(workspacePath);
    const requestId = crypto.randomUUID();
    await writeRuntimeRequest({
      workspacePath,
      request: {
        id: requestId,
        kind: "cancel_command",
        targetId: args.commandId,
      },
    });

    return toRuntimeResponseJson(
      await waitForRuntimeResponse({
        workspacePath,
        requestId,
        timeoutMs: TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        timeoutMessage:
          "Timed out waiting for Boboddy cancel command response from the local worker.",
      }),
    );
  },
});

export default boboddyCancelCommand;
