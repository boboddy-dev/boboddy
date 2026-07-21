import { execFile } from "node:child_process";
import path from "node:path";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  CheckoutBaseInput,
  CommitAllInput,
  CommitAllResult,
  CommitSubmoduleInput,
  CommitSubmoduleResult,
  CreateBranchInput,
  GitCommitPushService,
  PushInput,
  PushSubmoduleInput,
  SubmoduleHasChangesInput,
} from "../application/git-commit-push-service";
import { noopLogger, type Logger } from "../../../lib/logger";
import {
  chmodRecursiveWithDocker,
  isPermissionError,
} from "./docker-chmod-fallback";

const execFileAsync = promisify(execFile);

const GIT_BOT_NAME = "Boboddy Bot";
const GIT_BOT_EMAIL = "bot@boboddy.dev";

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/** Identity flags applied per-invocation (no global git config mutation). */
function identityArgs(): string[] {
  return [
    "-c",
    `user.name=${GIT_BOT_NAME}`,
    "-c",
    `user.email=${GIT_BOT_EMAIL}`,
  ];
}

/** A top-level pathspec exclude for `git add`, robust against .gitignore. */
function excludePathspec(relativePath: string): string {
  return `:(exclude,top)${relativePath}`;
}

export class GitCliCommitPushService implements GitCommitPushService {
  /**
   * @param chmodFallback Recover from root-owned files (created by the root-run
   *   devcontainer) before retrying a permission-failed git op. Injectable so
   *   tests can exercise the retry path without real Docker/root files.
   */
  constructor(
    private readonly logger: Logger = noopLogger,
    private readonly chmodFallback: (
      targetPath: string,
    ) => Promise<void> = chmodRecursiveWithDocker,
  ) {}

  protected async git(
    workspacePath: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", workspacePath, ...args],
      { env: gitEnv() },
    );
    return { stdout, stderr };
  }

  /**
   * Run a git operation and, if it fails with a permission error, chmod the
   * workspace via the Alpine fallback and retry ONCE. Root-owned files created
   * by the devcontainer are the cause.
   */
  private async gitWithPermissionRetry(
    workspacePath: string,
    args: readonly string[],
  ): Promise<void> {
    try {
      await this.git(workspacePath, args);
    } catch (error) {
      if (!isPermissionError(error instanceof Error ? error : undefined)) {
        throw error;
      }
      this.logger.warn(
        { args: args.join(" ") },
        "git operation hit a permission error; running chmod fallback and retrying once",
      );
      await this.chmodFallback(workspacePath);
      await this.git(workspacePath, args);
    }
  }

  async checkoutBase(input: CheckoutBaseInput): Promise<void> {
    await this.git(input.workspacePath, [
      "fetch",
      "origin",
      input.baseWorkBranch,
    ]);
    await this.git(input.workspacePath, ["checkout", input.baseWorkBranch]);
  }

  async createBranch(input: CreateBranchInput): Promise<void> {
    await this.git(input.workspacePath, [
      "checkout",
      "-b",
      input.branchName,
    ]);
  }

  async commitAll(input: CommitAllInput): Promise<CommitAllResult> {
    const committed = await this.stageExcludingAndCommit(
      input.workspacePath,
      input.message,
      input.excludePaths,
    );
    return { committed };
  }

  /**
   * Shared commit machinery for both the superproject and submodules: stage
   * everything except `excludePaths`, restore those excluded paths, then commit
   * the index with the injected Boboddy identity (no global config mutation).
   * Returns false when there was nothing to commit.
   */
  private async stageExcludingAndCommit(
    workspacePath: string,
    message: string,
    excludePaths: readonly string[],
  ): Promise<boolean> {
    // Stage everything EXCEPT the Boboddy runtime files.
    const addArgs = [
      "add",
      "-A",
      "--",
      ".",
      ...excludePaths.map(excludePathspec),
    ];
    await this.gitWithPermissionRetry(workspacePath, addArgs);

    // pathspec-exclude on `add` leaves excluded paths UNSTAGED, but if they are
    // tracked + modified they must be actively restored so a later `-a`-free
    // commit of the index doesn't include their prior staged state, and the
    // working tree is left clean of Boboddy edits for those paths.
    await this.restoreExcludedPaths(workspacePath, excludePaths);

    if (!(await this.hasStagedChanges(workspacePath))) {
      return false;
    }

    await this.gitWithPermissionRetry(workspacePath, [
      ...identityArgs(),
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
    ]);
    return true;
  }

  async push(input: PushInput): Promise<void> {
    await this.git(input.workspacePath, [
      "push",
      "--set-upstream",
      "origin",
      input.branchName,
    ]);
  }

  async submoduleHasChanges(
    input: SubmoduleHasChangesInput,
  ): Promise<boolean> {
    const subPath = path.join(input.workspacePath, input.submodulePath);
    // Guard: an uninitialized submodule has no `.git` (file or dir) inside it.
    // Treat it as "no changes" so it is never branched/committed.
    try {
      await access(path.join(subPath, ".git"));
    } catch {
      return false;
    }
    const { stdout } = await this.git(subPath, ["status", "--porcelain"]);
    return stdout.trim().length > 0;
  }

  async commitInSubmodule(
    input: CommitSubmoduleInput,
  ): Promise<CommitSubmoduleResult> {
    const subPath = path.join(input.workspacePath, input.submodulePath);
    // Submodules are typically in a detached HEAD; `checkout -b` works from it.
    await this.gitWithPermissionRetry(subPath, [
      "checkout",
      "-b",
      input.branchName,
    ]);
    // Boboddy runtime files are superproject-root-relative, so no excludes apply
    // inside a submodule — commit everything the agent changed.
    const committed = await this.stageExcludingAndCommit(
      subPath,
      input.message,
      [],
    );
    return { committed, branchCreated: true };
  }

  async pushSubmodule(input: PushSubmoduleInput): Promise<void> {
    const subPath = path.join(input.workspacePath, input.submodulePath);
    // Intentionally NOT wrapped: the orchestrator applies log-and-continue and
    // decides whether the superproject may record this submodule's gitlink.
    await this.git(subPath, [
      "push",
      "--set-upstream",
      "origin",
      input.branchName,
    ]);
  }

  /**
   * For each excluded path: unstage it and, if tracked, restore the working-tree
   * copy to HEAD so Boboddy runtime edits never reach the commit. Untracked
   * paths are simply left unstaged. Failures are ignored per-path (the path may
   * not exist in this repo).
   */
  private async restoreExcludedPaths(
    workspacePath: string,
    excludePaths: readonly string[],
  ): Promise<void> {
    for (const relativePath of excludePaths) {
      try {
        await this.git(workspacePath, [
          "restore",
          "--staged",
          "--",
          relativePath,
        ]);
      } catch {
        // Not staged / not present — nothing to unstage.
      }
      if (await this.isTracked(workspacePath, relativePath)) {
        try {
          await this.git(workspacePath, ["checkout", "--", relativePath]);
        } catch {
          // Best-effort restore.
        }
      }
    }
  }

  private async isTracked(
    workspacePath: string,
    relativePath: string,
  ): Promise<boolean> {
    try {
      const { stdout } = await this.git(workspacePath, [
        "ls-files",
        "--",
        relativePath,
      ]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async hasStagedChanges(workspacePath: string): Promise<boolean> {
    try {
      await this.git(workspacePath, [
        "diff",
        "--cached",
        "--quiet",
      ]);
      // Exit 0 => no staged changes.
      return false;
    } catch {
      // Non-zero exit => staged changes present.
      return true;
    }
  }
}
