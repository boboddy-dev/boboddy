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
 *      checked against `origin/<branch>` so the worker doesn't silently
 *      operate against state the user doesn't believe is on the remote.
 *      Local-ahead-of-origin (unpushed commits) is reported as a warning
 *      rather than blocking, since `origin/<branch>` is still a usable
 *      branch to run against; behind/diverged have no reasonable branch to
 *      fall back to and remain hard failures.
 *
 * Returns `{ branch: null }` (no error) when there is nothing to resolve:
 * `cwd` is not a git repository, or HEAD is detached (no current branch).
 * Both are treated as "opt out silently" rather than failures, since
 * `boboddy work` has always been usable from either context.
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

export type ResolveSourceBranchResult = {
  /** The branch to check out, or `null` when there's nothing to resolve. */
  branch: string | null;
  /**
   * Set when the current branch has local commits that haven't been pushed
   * to `origin/<branch>`. Non-fatal: the worker clones from `origin`, so it
   * will run against a state that doesn't include these commits. Callers
   * should surface this to the user (e.g. `reporter.warn`) but let the run
   * proceed rather than failing fast, unlike the other verification
   * failures below.
   */
  warning?: string;
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

/**
 * Returns a non-fatal warning message when the current branch has unpushed
 * commits, `undefined` when it's in exact sync with origin. Still throws
 * {@link SourceBranchVerificationError} for the other two out-of-sync cases
 * (behind, diverged) — those leave the worker no reasonable branch to clone,
 * where "ahead" at least has one: `origin/<branch>` as it stands.
 */
async function verifyCurrentBranchInSyncWithOrigin(
  gitPort: SourceBranchGitPort,
  cwd: string,
  branch: string,
): Promise<string | undefined> {
  const remoteSha = await fetchRemoteBranchShaOrThrow(
    gitPort,
    cwd,
    branch,
    false,
  );

  const localSha = await gitPort.getSha(cwd, "HEAD");
  if (localSha === remoteSha) {
    return undefined;
  }

  const remoteIsAncestorOfLocal = await gitPort.isAncestor(
    cwd,
    remoteSha,
    localSha,
  );
  if (remoteIsAncestorOfLocal) {
    return (
      `Current branch "${branch}" has commits that haven't been pushed to ` +
      `origin/${branch}. The run will use origin/${branch} as-is, which does ` +
      `not include these commits. Push it first: git push origin ${branch}`
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
 * with a user-facing message when the resolved branch isn't safely usable at
 * all (doesn't exist on origin, behind, or diverged); callers should fail
 * fast on that error rather than falling back silently. Unpushed local
 * commits are reported via {@link ResolveSourceBranchResult.warning} instead
 * of thrown — see there for why.
 *
 * `gitPort` defaults to the real git CLI implementation; tests inject a fake
 * to exercise the precedence/error logic without shelling out to git.
 */
export async function resolveSourceBranch(
  input: ResolveSourceBranchInput,
  gitPort: SourceBranchGitPort = new GitCliSourceBranchPort(),
): Promise<ResolveSourceBranchResult> {
  const override = input.override?.trim();
  if (override) {
    await fetchRemoteBranchShaOrThrow(gitPort, input.cwd, override, true);
    return { branch: override };
  }

  const isRepo = await gitPort.isGitRepository(input.cwd);
  if (!isRepo) {
    return { branch: null };
  }

  const branch = await gitPort.getCurrentBranch(input.cwd);
  if (!branch) {
    // Detached HEAD (or otherwise unresolvable) — nothing to resolve.
    return { branch: null };
  }

  const warning = await verifyCurrentBranchInSyncWithOrigin(
    gitPort,
    input.cwd,
    branch,
  );
  return { branch, warning };
}
