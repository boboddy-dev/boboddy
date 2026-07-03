import { access } from "node:fs/promises";
import path from "node:path";

const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".boboddy/current-execution/execution.json";
const DEFAULT_CONTAINER_WORKSPACE_ROOT = "/workspace";

/**
 * Resolve the workspace folder this plugin operates against inside the runtime
 * container. The worker sets `BOBODDY_WORKSPACE_FOLDER` to the resolved runtime
 * workspace folder; the default preserves the historical AI-container mount
 * (`/workspace`) for current behavior until that env is wired by the launcher.
 */
function resolveContainerWorkspaceRoot(): string {
  const fromEnv = process.env["BOBODDY_WORKSPACE_FOLDER"]?.trim();
  return fromEnv || DEFAULT_CONTAINER_WORKSPACE_ROOT;
}

/**
 * Resolves the effective workspace root from `context.worktree`.
 *
 * When OpenCode runs inside a container its worktree is often reported as `"/"`.
 * In that case we probe for `.boboddy/current-execution/execution.json` under
 * the resolved workspace root and, if found, return that root as the true
 * workspace root. For any other worktree value the path is returned unchanged.
 */
export async function resolveWorktree(worktree: string): Promise<string> {
  if (worktree !== "/") {
    return worktree;
  }

  const containerWorkspaceRoot = resolveContainerWorkspaceRoot();
  try {
    await access(
      path.join(containerWorkspaceRoot, CURRENT_EXECUTION_INFO_RELATIVE_PATH),
    );
    return containerWorkspaceRoot;
  } catch {
    return worktree;
  }
}
