import { GitCliSourceBranchPort } from "../infra/git-cli-source-branch-port";

/**
 * Resolve the branch `boboddy work` checks out for the FIRST step of a
 * pipeline attempt, immediately after the worker clones the repo — distinct
 * from `baseWorkBranch` (the predecessor step's work branch, handed down by
 * the server for later steps; see `process-claimed-step-execution-helpers`).
 *
 * Two sources, in precedence order:
 *   1. An explicit override (e.g. `--source-branch`) — the caller's intent is
 *      unambiguous, so only existence on `origin` is verified; the branch
 *      need not be checked out locally (targeting CI or a colleague's branch
 *      is an explicit use case).
 *   2. The user's current local branch (`git rev-parse --abbrev-ref HEAD`) —
 *      verified to be pushed and in exact sync with `origin/<branch>` (not
 *      merely an ancestor/descendant), so the worker never operates against
 *      state the user doesn't believe is on the remote.
 *
 * Returns `null` (no error) when there is nothing to resolve: `cwd` is not a
 * git repository, or HEAD is detached (no current branch). Both are treated
 * as "opt out silently" rather than failures, since `boboddy work` has always
 * been usable from either context.
 */
export class SourceBranchVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceBranchVerificationError";
  }
}

/**
 * The git operations {@link resolveSourceBranch} needs, kept narrow and
 * injectable so the precedence/error logic can be unit tested against a fake
 * without shelling out to real git. See `GitCliSourceBranchPort` for the real
 * implementation.
 */
export type SourceBranchGitPort = {
  /** True when `cwd` is inside a git working tree. */
  isGitRepository(cwd: string): Promise<boolean>;
  /** The current branch name, or `null` on detached HEAD (or unresolvable). */
  getCurrentBranch(cwd: string): Promise<string | null>;
  /**
   * Fetch `branch` from `origin` and return its SHA, or `null` when it does
   * not exist on `origin`. Must not mutate any local branch ref (safe to call
   * regardless of which branch is currently checked out).
   */
  fetchRemoteBranchSha(cwd: string, branch: string): Promise<string | null>;
  /** Resolve `ref` (e.g. `"HEAD"`) to its SHA. */
  getSha(cwd: string, ref: string): Promise<string>;
  /** True when `ancestorSha` is an ancestor of (or equal to) `descendantSha`. */
  isAncestor(
    cwd: string,
    ancestorSha: string,
    descendantSha: string,
  ): Promise<boolean>;
};

export type ResolveSourceBranchInput = {
  /** The user's working directory at `boboddy work` invocation. */
  cwd: string;
  /** Explicit override (e.g. `--source-branch`); trimmed, empty treated as unset. */
  override?: string | undefined;
};

function buildNotOnOriginMessage(branch: string, isOverride: boolean): string {
  if (isOverride) {
    return (
      `Branch "${branch}" (--source-branch) does not exist on origin. ` +
      `Push it first, or choose a branch that does.`
    );
  }
  return (
    `Current branch "${branch}" does not exist on origin. ` +
    `Push it first: git push -u origin ${branch}`
  );
}

/**
 * Fetch `branch` from `origin`, returning its SHA, or throw a
 * {@link SourceBranchVerificationError} when it doesn't exist there. Shared by
 * both the override path (existence only) and the current-branch path
 * (existence, then exact-sync comparison below).
 */
async function fetchRemoteBranchShaOrThrow(
  gitPort: SourceBranchGitPort,
  cwd: string,
  branch: string,
  isOverride: boolean,
): Promise<string> {
  const remoteSha = await gitPort.fetchRemoteBranchSha(cwd, branch);
  if (remoteSha === null) {
    throw new SourceBranchVerificationError(
      buildNotOnOriginMessage(branch, isOverride),
    );
  }
  return remoteSha;
}

async function verifyCurrentBranchInSyncWithOrigin(
  gitPort: SourceBranchGitPort,
  cwd: string,
  branch: string,
): Promise<void> {
  const remoteSha = await fetchRemoteBranchShaOrThrow(
    gitPort,
    cwd,
    branch,
    false,
  );

  const localSha = await gitPort.getSha(cwd, "HEAD");
  if (localSha === remoteSha) {
    return;
  }

  const remoteIsAncestorOfLocal = await gitPort.isAncestor(
    cwd,
    remoteSha,
    localSha,
  );
  if (remoteIsAncestorOfLocal) {
    throw new SourceBranchVerificationError(
      `Current branch "${branch}" has commits that haven't been pushed to ` +
        `origin/${branch}. Push it first: git push origin ${branch}`,
    );
  }

  const localIsAncestorOfRemote = await gitPort.isAncestor(
    cwd,
    localSha,
    remoteSha,
  );
  if (localIsAncestorOfRemote) {
    throw new SourceBranchVerificationError(
      `Current branch "${branch}" is behind origin/${branch}. Pull the ` +
        `latest changes first: git pull`,
    );
  }

  throw new SourceBranchVerificationError(
    `Current branch "${branch}" has diverged from origin/${branch}. ` +
      `Reconcile the histories (e.g. rebase or merge) before running boboddy work.`,
  );
}

/**
 * Resolve (and verify) the branch `boboddy work` should check out for the
 * first step of a pipeline attempt. Throws {@link SourceBranchVerificationError}
 * with a user-facing message when the resolved branch isn't safely usable;
 * callers should fail fast on that error rather than falling back silently.
 *
 * `gitPort` defaults to the real git CLI implementation; tests inject a fake
 * to exercise the precedence/error logic without shelling out to git.
 */
export async function resolveSourceBranch(
  input: ResolveSourceBranchInput,
  gitPort: SourceBranchGitPort = new GitCliSourceBranchPort(),
): Promise<string | null> {
  const override = input.override?.trim();
  if (override) {
    await fetchRemoteBranchShaOrThrow(gitPort, input.cwd, override, true);
    return override;
  }

  const isRepo = await gitPort.isGitRepository(input.cwd);
  if (!isRepo) {
    return null;
  }

  const branch = await gitPort.getCurrentBranch(input.cwd);
  if (!branch) {
    // Detached HEAD (or otherwise unresolvable) — nothing to resolve.
    return null;
  }

  await verifyCurrentBranchInSyncWithOrigin(gitPort, input.cwd, branch);
  return branch;
}
