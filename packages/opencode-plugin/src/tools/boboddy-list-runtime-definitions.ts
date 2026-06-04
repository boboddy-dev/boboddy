import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { parseBoboddyConfig } from "./_shared/boboddy-config-parser";
import { resolveWorktree } from "./_shared/resolve-worktree";

const boboddyListRuntimeDefinitions: ToolDefinition = tool({
  description:
    "List Boboddy project runtime commands and services from .boboddy/boboddy.jsonc when available.",
  args: {},
  async execute(_args, context) {
    const result = await parseBoboddyConfig(await resolveWorktree(context.worktree));

    if (!result.found) {
      return JSON.stringify(
        {
          ok: false,
          error: "No .boboddy/boboddy.jsonc found in workspace",
          data: null,
        },
        null,
        2,
      );
    }

    return JSON.stringify(
      { ok: true, error: null, data: result.config },
      null,
      2,
    );
  },
});

export default boboddyListRuntimeDefinitions;
