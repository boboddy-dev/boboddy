import type { GitCommitPushService } from "../../../runtime/runtime-service/application/git-commit-push-service";
import type { SubmoduleService } from "../../../runtime/runtime-service/application/submodule-service";
import { sanitizeGitRefFragment } from "../../../runtime/runtime-service/domain/git-ref-name";
import { MANAGED_DEVCONTAINERS_DIR } from "../../../runtime/runtime-service/domain/managed-runtimes";
import type { RepoOnPushFailure } from "@boboddy/sdk/repo-config";
import type { AnyJsonValue } from "../../../common/contracts/json";
import { startStopwatch } from "../../../lib/elapsed";
import { logWork } from "../application/work-logger";
import type {
  CommitAndPushWorkBranchResult,
  ProjectWorkLogger,
} from "../contracts/process-project-work-types";
import { renderCommitMessage } from "./work-branch-commit-message";

/**
 * Repo-relative Boboddy runtime files that must NEVER be committed to a work
 * branch, regardless of the target repo's .gitignore.
 */
export const WORK_BRANCH_EXCLUDE_PATHS = [
  ".opencode/plugins/boboddy.js",
  ".boboddy/current-execution",
  ".boboddy/step-findings-submission.json",
  ".boboddy/step-artifacts",
  ".devcontainer/devcontainer.json",
  MANAGED_DEVCONTAINERS_DIR,
] as const;

/** Prefix used when the repo config does not specify a valid `branchPrefix`. */
export const DEFAULT_BRANCH_PREFIX = "boboddy";

/**
 * Build the work branch name `<prefix>/<sanitized-key>-<stepExecutionId>`.
 *
 * The prefix defaults to `boboddy`. A caller-supplied `branchPrefix` (from the
 * repo's `.boboddy/boboddy.jsonc`) is sanitized with the same git-ref rules as
 * the step key; if it sanitizes to empty it falls back to the default.
 */
export function buildWorkBranchName(input: {
  stepKey: string;
  stepExecutionId: string;
  branchPrefix?: string | null | undefined;
}): string {
  const key = sanitizeGitRefFragment(input.stepKey);
  const prefix = resolveBranchPrefix(input.branchPrefix);
  return `${prefix}/${key}-${input.stepExecutionId}`;
}

/**
 * Resolve the effective branch prefix: sanitize the configured value and fall
 * back to {@link DEFAULT_BRANCH_PREFIX} when unset or empty after sanitizing.
 *
 * `sanitizeGitRefFragment` substitutes a `"step"` placeholder for input that is
 * empty after sanitizing, which is meaningful for step keys but not for a
 * prefix. To distinguish a user who literally configured `"step"` from invalid
 * input, we sanitize and re-check: if sanitizing produced the placeholder AND
 * the raw value was not already `"step"`, the prefix was invalid.
 */
function resolveBranchPrefix(branchPrefix: string | null | undefined): string {
  const raw = branchPrefix?.trim();
  if (!raw) return DEFAULT_BRANCH_PREFIX;
  const sanitized = sanitizeGitRefFragment(raw);
  if (sanitized === "step" && raw.toLowerCase() !== "step") {
    return DEFAULT_BRANCH_PREFIX;
  }
  return sanitized;
}

export type PrepareWorkBranchInput = {
  gitCommitPushService: GitCommitPushService;
  workspacePath: string;
  /** The cloned default branch, used as the base when `baseWorkBranch` is null. */
  resolvedBranch: string;
  /**
   * The branch this step is created off of: the previous step's work branch
   * (later steps) or a repo-local configured base branch (first step). Null
   * means use the cloned default branch (`resolvedBranch`).
   */
  baseWorkBranch: string | null;
  stepKey: string;
  stepExecutionId: string;
  /** Optional prefix from the repo config; defaults to `boboddy`. */
  branchPrefix?: string | null | undefined;
  /** Receives the info-level timing line, so it ships in the step log. */
  logger?: ProjectWorkLogger | undefined;
};

export type PreparedWorkBranch = {
  workBranch: string;
  createdFromBranch: string;
};

/**
 * Put the workspace on the step's base branch right after clone and return it:
 *  - `baseWorkBranch` set (later step, or first step with a configured base):
 *    `checkoutBase`. A checkout failure propagates and fails the step — the
 *    requested base branch must exist and be fetchable.
 *  - otherwise: nothing to check out; the workspace is already on the resolved
 *    (cloned default) branch, which is the base.
 *
 * Runs alone for `readOnly` steps and dry runs, which create no work branch.
 */
export async function checkoutBaseBranch(
  input: Pick<
    PrepareWorkBranchInput,
    | "gitCommitPushService"
    | "workspacePath"
    | "resolvedBranch"
    | "baseWorkBranch"
  >,
): Promise<string> {
  if (!input.baseWorkBranch) return input.resolvedBranch;

  await input.gitCommitPushService.checkoutBase({
    workspacePath: input.workspacePath,
    baseWorkBranch: input.baseWorkBranch,
  });
  return input.baseWorkBranch;
}

/**
 * Check out the base (see {@link checkoutBaseBranch}) and create the step's
 * work branch off it.
 */
export async function prepareWorkBranch(
  input: PrepareWorkBranchInput,
): Promise<PreparedWorkBranch> {
  const elapsed = startStopwatch();
  const createdFromBranch = await checkoutBaseBranch(input);

  const workBranch = buildWorkBranchName({
    stepKey: input.stepKey,
    stepExecutionId: input.stepExecutionId,
    branchPrefix: input.branchPrefix,
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
  input.logger?.log("runtime", `work branch prepared in ${elapsed()}`);

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
 * Raised when a work branch (or a submodule's copy of it) cannot be pushed and
 * the step's `onPushFailure` is `"fail"`. The message names the branch and
 * carries the underlying git error.
 */
export class WorkBranchPushError extends Error {
  readonly workBranch: string;
  readonly submodulePath: string | null;

  constructor(input: {
    workBranch: string;
    submodulePath?: string | undefined;
    cause: unknown;
  }) {
    const reason =
      input.cause instanceof Error ? input.cause.message : String(input.cause);
    const target = input.submodulePath
      ? `submodule "${input.submodulePath}" work branch "${input.workBranch}"`
      : `work branch "${input.workBranch}"`;
    super(`Failed to push ${target}: ${reason}`, {
      cause: input.cause,
    });
    this.name = "WorkBranchPushError";
    this.workBranch = input.workBranch;
    this.submodulePath = input.submodulePath ?? null;
  }
}

/**
 * For each initialized submodule that HAS changes: lazily create the same work
 * branch, commit, and push to the submodule's own `origin`. Push success →
 * gitlink recordable. Push failure → throws a {@link WorkBranchPushError} under
 * `onPushFailure: "fail"`; under `"warn"` it logs, continues, and DOES NOT
 * record the gitlink. Uninitialized submodules are skipped (never
 * branched/committed).
 */
async function processSubmodules(input: {
  gitCommitPushService: GitCommitPushService;
  submoduleService: SubmoduleService;
  workspacePath: string;
  workBranch: string;
  message: string;
  onPushFailure: RepoOnPushFailure;
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
      if (input.onPushFailure === "fail") {
        throw new WorkBranchPushError({
          workBranch: input.workBranch,
          submodulePath: submodule.path,
          cause: error,
        });
      }
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
 * pushes it, for `readWrite` steps. Submodules with changes are
 * branched/committed/pushed FIRST so successfully-pushed gitlinks can be
 * recorded by the superproject commit. Commit "nothing to commit" is a success.
 *
 * The commit message (superproject and submodules alike) is `message` rendered
 * against the step's input and the submitted `result`, or `boboddy: step <id>`;
 * see {@link renderCommitMessage}.
 *
 * Push-failure policy, set by `onPushFailure` (default `"fail"`):
 *  - `"fail"`: a failed push of the work branch or of a submodule throws a
 *    {@link WorkBranchPushError} naming the branch, which fails the step. A
 *    green step whose work was never pushed is worse than a red one.
 *  - `"warn"`: the failure is logged and the step carries on. A failed
 *    submodule's gitlink is still excluded from the superproject commit so it
 *    never records an unreachable SHA.
 *
 * The closure resolves `{ pushed }`, which is `false` only when the
 * superproject work branch push failed under `"warn"`: the branch is then not
 * on the remote, so the caller must not report it as the step's work branch. A
 * failed submodule push does not clear `pushed`, because the superproject
 * branch (minus that gitlink) is still on the remote and usable as a base.
 */
export function buildCommitAndPushWorkBranch(input: {
  gitCommitPushService: GitCommitPushService;
  submoduleService: SubmoduleService;
  workspacePath: string;
  workBranch: string;
  stepExecutionId: string;
  /** Commit message template; null or omitted means the default message. */
  message?: string | null | undefined;
  /** The step's additional input, the `{{input.…}}` token source. */
  inputJson?: unknown;
  onPushFailure?: RepoOnPushFailure | undefined;
  /**
   * Extra repo-relative paths to keep out of the commit, beyond
   * {@link WORK_BRANCH_EXCLUDE_PATHS}: the devcontainer config the worker
   * patched before launch, which may live anywhere in the repo, and for a
   * managed runtime the install's own artifacts.
   */
  extraExcludePaths?: readonly string[] | undefined;
}): (ctx: { result: AnyJsonValue }) => Promise<CommitAndPushWorkBranchResult> {
  const onPushFailure = input.onPushFailure ?? "fail";

  return async ({ result }) => {
    const message = renderCommitMessage({
      template: input.message ?? null,
      stepExecutionId: input.stepExecutionId,
      inputJson: input.inputJson,
      result,
    });

    const submoduleResult = await processSubmodules({
      gitCommitPushService: input.gitCommitPushService,
      submoduleService: input.submoduleService,
      workspacePath: input.workspacePath,
      workBranch: input.workBranch,
      message,
      onPushFailure,
    });

    logWork("runtime", "Submodule work-branch summary", {
      workBranch: input.workBranch,
      detected: submoduleResult.detected,
      changed:
        submoduleResult.pushedSubmodulePaths.length +
        submoduleResult.failedSubmodulePaths.length,
      pushed: submoduleResult.pushedSubmodulePaths,
      failed: submoduleResult.failedSubmodulePaths,
    });

    const { committed } = await input.gitCommitPushService.commitAll({
      workspacePath: input.workspacePath,
      message,
      excludePaths: [
        ...new Set([
          ...WORK_BRANCH_EXCLUDE_PATHS,
          ...(input.extraExcludePaths ?? []),
          ...submoduleResult.failedSubmodulePaths,
        ]),
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
      return { pushed: true };
    } catch (error) {
      if (onPushFailure === "fail") {
        throw new WorkBranchPushError({
          workBranch: input.workBranch,
          cause: error,
        });
      }
      logWork("runtime", "Failed to push work branch (continuing)", {
        workBranch: input.workBranch,
        error: error instanceof Error ? error.message : String(error),
      });
      return { pushed: false };
    }
  };
}
