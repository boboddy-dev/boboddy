import type { RepoConfig } from "@boboddy/sdk/repo-config";
import { loadProjectConfig } from "../../../project/project-config/infra/fs-project-config-repo";
import type { GitCommitPushService } from "../../../runtime/runtime-service/application/git-commit-push-service";
import { resolveConfiguredBaseWorkBranch } from "../application/process-claimed-step-execution-helpers";
import type { ProjectWorkLogger } from "../contracts/process-project-work-types";
import { checkoutBaseBranch, prepareWorkBranch } from "./work-branch-manager";

export type LaunchBranchSetup = {
  /** Null when the step creates no work branch. */
  workBranch: string | null;
  /** Null when the step creates no work branch. */
  createdFromBranch: string | null;
  /** The branch the devcontainer config is looked up on. */
  devcontainerLookupBranch: string;
};

/**
 * Put a freshly cloned workspace on the right branch for a step.
 *
 * A `readWrite` step with a step key gets a work branch created off its base.
 * Every other launch (a `readOnly` step, or a dry run, which has no step key)
 * only checks out the base and reports no work branch, so nothing is committed
 * or pushed. The base is the server-handed predecessor branch, else the CLI's
 * source branch, else (step runs only) the repo-local configured base, else the
 * cloned default branch.
 */
export async function setUpLaunchBranches(input: {
  gitCommitPushService: GitCommitPushService;
  workspacePath: string;
  resolvedBranch: string;
  repo: RepoConfig;
  stepKey?: string | undefined;
  stepExecutionId: string;
  baseWorkBranch?: string | null | undefined;
  sourceBranch?: string | null | undefined;
  localEnvVars: Record<string, string>;
  logger?: ProjectWorkLogger | undefined;
}): Promise<LaunchBranchSetup> {
  const { stepKey } = input;
  const projectConfig = stepKey
    ? await loadProjectConfig(input.workspacePath)
    : null;

  const baseWorkBranch = stepKey
    ? (input.baseWorkBranch ??
      input.sourceBranch ??
      resolveConfiguredBaseWorkBranch({
        localEnvVars: input.localEnvVars,
        configuredBaseWorkBranch: projectConfig?.baseWorkBranch ?? null,
      }))
    : input.baseWorkBranch
      ? null
      : (input.sourceBranch ?? null);

  if (stepKey && input.repo.mode === "readWrite") {
    const prepared = await prepareWorkBranch({
      gitCommitPushService: input.gitCommitPushService,
      workspacePath: input.workspacePath,
      resolvedBranch: input.resolvedBranch,
      baseWorkBranch,
      stepKey,
      stepExecutionId: input.stepExecutionId,
      branchPrefix: projectConfig?.branchPrefix ?? null,
      logger: input.logger,
    });
    return {
      workBranch: prepared.workBranch,
      createdFromBranch: prepared.createdFromBranch,
      devcontainerLookupBranch: prepared.createdFromBranch,
    };
  }

  const base = await checkoutBaseBranch({
    gitCommitPushService: input.gitCommitPushService,
    workspacePath: input.workspacePath,
    resolvedBranch: input.resolvedBranch,
    baseWorkBranch,
  });
  return {
    workBranch: null,
    createdFromBranch: null,
    devcontainerLookupBranch: base,
  };
}
