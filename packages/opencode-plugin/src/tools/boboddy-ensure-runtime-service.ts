import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import {
  assertWorkspaceReadable,
  toRuntimeResponseJson,
  waitForRuntimeResponse,
  writeRuntimeRequest,
} from "./_shared/runtime-request";
import { resolveWorktree } from "./_shared/resolve-worktree";

const POLL_INTERVAL_MS = 250;
const TIMEOUT_MS = 90_000;

const boboddyEnsureRuntimeService: ToolDefinition = tool({
  description:
    "Ensure a Boboddy runtime service defined in .boboddy/opencode.jsonc is started inside the user's devcontainer and return its access details.",
  args: {
    serviceName: tool.schema
      .string()
      .describe("Name of the configured service to start or reuse"),
  },
  async execute(args, context) {
    const workspacePath = await resolveWorktree(context.worktree);
    await assertWorkspaceReadable(workspacePath);
    const requestId = crypto.randomUUID();
    await writeRuntimeRequest({
      workspacePath,
      request: {
        id: requestId,
        kind: "ensure_service",
        serviceName: args.serviceName,
      },
    });

    return toRuntimeResponseJson(
      await waitForRuntimeResponse({
        workspacePath,
        requestId,
        timeoutMs: TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        timeoutMessage:
          "Timed out waiting for Boboddy runtime service readiness response from the local worker.",
      }),
    );
  },
});

export default boboddyEnsureRuntimeService;
