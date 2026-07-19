export type CheckoutBaseInput = {
  workspacePath: string;
  /** The previous step's work branch to base this step off of. */
  baseWorkBranch: string;
};

export type CreateBranchInput = {
  workspacePath: string;
  branchName: string;
};

export type CommitAllInput = {
  workspacePath: string;
  message: string;
  /**
   * Repo-relative paths that must never be committed (Boboddy runtime files).
   * Applied as git pathspec excludes and, when tracked+modified, restored
   * before commit so they cannot sneak in.
   */
  excludePaths: readonly string[];
};

export type CommitAllResult = {
  /** False when there was nothing to commit (a no-op, treated as success). */
  committed: boolean;
};

export type PushInput = {
  workspacePath: string;
  branchName: string;
};

/**
 * Host-side git operations for the branch-per-step feature: check out a base
 * work branch (later steps), create the step's `boboddy/...` work branch, commit
 * the agent's changes excluding Boboddy runtime files, and push the branch.
 *
 * Split into single-purpose methods mirroring {@link GitCloneService}.
 */
export type GitCommitPushService = {
  checkoutBase(input: CheckoutBaseInput): Promise<void>;
  createBranch(input: CreateBranchInput): Promise<void>;
  commitAll(input: CommitAllInput): Promise<CommitAllResult>;
  push(input: PushInput): Promise<void>;
};
