import { access } from "node:fs/promises";
import path from "node:path";

const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".boboddy/current-execution/execution.json";
const CONTAINER_WORKSPACE_ROOT = "/workspace";

/**
 * Resolves the effective workspace root from `context.worktree`.
 *
 * When OpenCode runs inside a container its worktree is often reported as `"/"`.
 * In that case we probe for `.boboddy/current-execution/execution.json` under
 * `/workspace` and, if found, return `/workspace` as the true workspace root.
 * For any other worktree value the path is returned unchanged.
 */
export async function resolveWorktree(worktree: string): Promise<string> {
  if (worktree !== "/") {
    return worktree;
  }

  try {
    await access(
      path.join(CONTAINER_WORKSPACE_ROOT, CURRENT_EXECUTION_INFO_RELATIVE_PATH),
    );
    return CONTAINER_WORKSPACE_ROOT;
  } catch {
    return worktree;
  }
}
