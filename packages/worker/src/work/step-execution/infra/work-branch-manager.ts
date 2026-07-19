import type { GitCommitPushService } from "../../../runtime/runtime-service/application/git-commit-push-service";
import { sanitizeGitRefFragment } from "../../../runtime/runtime-service/domain/git-ref-name";
import { logWork } from "../application/work-logger";

/**
 * Repo-relative Boboddy runtime files that must NEVER be committed to a work
 * branch, regardless of the target repo's .gitignore.
 */
export const WORK_BRANCH_EXCLUDE_PATHS = [
  ".opencode/plugins/boboddy.js",
  ".boboddy/current-execution",
  ".devcontainer/devcontainer.json",
] as const;

const FEATURE_FLAG_ENV = "BOBODDY_BRANCH_PER_STEP";

/** True when the branch-per-step feature is enabled via env flag. */
export function isBranchPerStepEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[FEATURE_FLAG_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Build the work branch name `boboddy/<sanitized-key>-<stepExecutionId>`. */
export function buildWorkBranchName(input: {
  stepKey: string;
  stepExecutionId: string;
}): string {
  const key = sanitizeGitRefFragment(input.stepKey);
  return `boboddy/${key}-${input.stepExecutionId}`;
}

export type PrepareWorkBranchInput = {
  gitCommitPushService: GitCommitPushService;
  workspacePath: string;
  /** The resolved clone branch (base for the first step). */
  resolvedBranch: string;
  /** The previous step's work branch (base for later steps), if any. */
  baseWorkBranch: string | null;
  stepKey: string;
  stepExecutionId: string;
};

export type PreparedWorkBranch = {
  workBranch: string;
  createdFromBranch: string;
};

/**
 * Determine the base for the work branch and create it right after clone:
 *  - later step (baseWorkBranch set): `checkoutBase` then branch off it.
 *  - first step: branch off the resolved clone branch.
 */
export async function prepareWorkBranch(
  input: PrepareWorkBranchInput,
): Promise<PreparedWorkBranch> {
  let createdFromBranch: string;

  if (input.baseWorkBranch) {
    await input.gitCommitPushService.checkoutBase({
      workspacePath: input.workspacePath,
      baseWorkBranch: input.baseWorkBranch,
    });
    createdFromBranch = input.baseWorkBranch;
  } else {
    createdFromBranch = input.resolvedBranch;
  }

  const workBranch = buildWorkBranchName({
    stepKey: input.stepKey,
    stepExecutionId: input.stepExecutionId,
  });

  await input.gitCommitPushService.createBranch({
    workspacePath: input.workspacePath,
    branchName: workBranch,
  });

  logWork("runtime", "Created work branch for step", {
    workspacePath: input.workspacePath,
    workBranch,
    createdFromBranch,
  });

  return { workBranch, createdFromBranch };
}

/**
 * Build the closure that commits the agent's changes to the work branch and
 * pushes it. Commit "nothing to commit" is a success. Push failures are logged
 * but NOT propagated (the findings are still valid).
 */
export function buildCommitAndPushWorkBranch(input: {
  gitCommitPushService: GitCommitPushService;
  workspacePath: string;
  workBranch: string;
  stepExecutionId: string;
}): () => Promise<void> {
  return async () => {
    const { committed } = await input.gitCommitPushService.commitAll({
      workspacePath: input.workspacePath,
      message: `boboddy: step ${input.stepExecutionId}`,
      excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
    });
    logWork("runtime", "Committed work branch changes", {
      workspacePath: input.workspacePath,
      workBranch: input.workBranch,
      committed,
    });

    try {
      await input.gitCommitPushService.push({
        workspacePath: input.workspacePath,
        branchName: input.workBranch,
      });
      logWork("runtime", "Pushed work branch", {
        workBranch: input.workBranch,
      });
    } catch (error) {
      // Locked decision: push failure does NOT fail the step.
      logWork("runtime", "Failed to push work branch (continuing)", {
        workBranch: input.workBranch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
