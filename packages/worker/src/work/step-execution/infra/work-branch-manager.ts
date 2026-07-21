import type { GitCommitPushService } from "../../../runtime/runtime-service/application/git-commit-push-service";
import type { SubmoduleService } from "../../../runtime/runtime-service/application/submodule-service";
import { sanitizeGitRefFragment } from "../../../runtime/runtime-service/domain/git-ref-name";
import { logWork } from "../application/work-logger";

/**
 * Repo-relative Boboddy runtime files that must NEVER be committed to a work
 * branch, regardless of the target repo's .gitignore.
 */
export const WORK_BRANCH_EXCLUDE_PATHS = [
  ".opencode/plugins/boboddy.js",
  ".boboddy/current-execution",
  ".boboddy/step-findings-submission.json",
  ".devcontainer/devcontainer.json",
] as const;

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
 * Outcome of processing all submodules: which ones were pushed successfully
 * (their gitlink may be recorded by the superproject) and which failed (their
 * gitlink must be excluded to avoid a dangling pointer).
 */
type SubmoduleProcessingResult = {
  detected: number;
  pushedSubmodulePaths: string[];
  failedSubmodulePaths: string[];
};

/**
 * For each initialized submodule that HAS changes: lazily create the same work
 * branch, commit, and push to the submodule's own `origin`. Push success →
 * gitlink recordable; push failure → log-and-continue and DO NOT record the
 * gitlink. Uninitialized submodules are skipped (never branched/committed).
 */
async function processSubmodules(input: {
  gitCommitPushService: GitCommitPushService;
  submoduleService: SubmoduleService;
  workspacePath: string;
  workBranch: string;
  message: string;
}): Promise<SubmoduleProcessingResult> {
  const submodules = await input.submoduleService.detectSubmodules({
    workspacePath: input.workspacePath,
  });

  const pushedSubmodulePaths: string[] = [];
  const failedSubmodulePaths: string[] = [];

  for (const submodule of submodules) {
    // Uninitialized/empty submodules are treated as "no changes".
    if (!submodule.initialized) {
      continue;
    }

    const hasChanges = await input.gitCommitPushService.submoduleHasChanges({
      workspacePath: input.workspacePath,
      submodulePath: submodule.path,
    });
    if (!hasChanges) {
      continue;
    }

    await input.gitCommitPushService.commitInSubmodule({
      workspacePath: input.workspacePath,
      submodulePath: submodule.path,
      branchName: input.workBranch,
      message: input.message,
    });

    try {
      await input.gitCommitPushService.pushSubmodule({
        workspacePath: input.workspacePath,
        submodulePath: submodule.path,
        branchName: input.workBranch,
      });
      pushedSubmodulePaths.push(submodule.path);
      logWork("runtime", "Pushed submodule work branch", {
        submodulePath: submodule.path,
        workBranch: input.workBranch,
      });
    } catch (error) {
      // Locked decision: submodule push failure does NOT fail the step, and its
      // gitlink must NOT be recorded by the superproject (dangling pointer).
      failedSubmodulePaths.push(submodule.path);
      logWork("runtime", "Failed to push submodule work branch (continuing)", {
        submodulePath: submodule.path,
        workBranch: input.workBranch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    detected: submodules.length,
    pushedSubmodulePaths,
    failedSubmodulePaths,
  };
}

/**
 * Build the closure that commits the agent's changes to the work branch and
 * pushes it. Submodules with changes are branched/committed/pushed FIRST so
 * successfully-pushed gitlinks can be recorded by the superproject commit;
 * failed ones are excluded to avoid dangling pointers. Commit "nothing to
 * commit" is a success. Push failures are logged but NOT propagated.
 */
export function buildCommitAndPushWorkBranch(input: {
  gitCommitPushService: GitCommitPushService;
  submoduleService: SubmoduleService;
  workspacePath: string;
  workBranch: string;
  stepExecutionId: string;
}): () => Promise<void> {
  return async () => {
    const message = `boboddy: step ${input.stepExecutionId}`;

    // Process submodules FIRST so their pushed SHAs are reachable before the
    // superproject records the moved gitlinks.
    const submoduleResult = await processSubmodules({
      gitCommitPushService: input.gitCommitPushService,
      submoduleService: input.submoduleService,
      workspacePath: input.workspacePath,
      workBranch: input.workBranch,
      message,
    });

    logWork("runtime", "Submodule work-branch summary", {
      // Every changed submodule reuses this same superproject work-branch name.
      workBranch: input.workBranch,
      detected: submoduleResult.detected,
      changed:
        submoduleResult.pushedSubmodulePaths.length +
        submoduleResult.failedSubmodulePaths.length,
      pushed: submoduleResult.pushedSubmodulePaths,
      failed: submoduleResult.failedSubmodulePaths,
    });

    // Exclude the gitlinks of submodules whose push FAILED so the superproject
    // commit never records an unreachable SHA. Reuses the same pathspec-exclude
    // mechanism as the Boboddy runtime files.
    const { committed } = await input.gitCommitPushService.commitAll({
      workspacePath: input.workspacePath,
      message,
      excludePaths: [
        ...WORK_BRANCH_EXCLUDE_PATHS,
        ...submoduleResult.failedSubmodulePaths,
      ],
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
