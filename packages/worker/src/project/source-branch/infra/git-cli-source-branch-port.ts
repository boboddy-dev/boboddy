import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SourceBranchGitPort } from "../application/resolve-source-branch";

const execFileAsync = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/**
 * Real git CLI implementation of {@link SourceBranchGitPort}, operating
 * against the user's own local clone (`cwd`) — distinct from the worker's
 * git-clone-service/git-commit-push-service, which always operate on the
 * freshly-cloned throwaway workspace, not the user's own working directory.
 */
export class GitCliSourceBranchPort implements SourceBranchGitPort {
  protected async git(
    cwd: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return await execFileAsync("git", ["-C", cwd, ...args], {
      env: gitEnv(),
    });
  }

  async isGitRepository(cwd: string): Promise<boolean> {
    try {
      await this.git(cwd, ["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(cwd, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      const branch = stdout.trim();
      return branch && branch !== "HEAD" ? branch : null;
    } catch {
      return null;
    }
  }

  async fetchRemoteBranchSha(
    cwd: string,
    branch: string,
  ): Promise<string | null> {
    try {
      // Fetches into FETCH_HEAD without touching any local branch ref, so
      // this is safe to call regardless of what's currently checked out.
      await this.git(cwd, ["fetch", "origin", branch]);
      const { stdout } = await this.git(cwd, ["rev-parse", "FETCH_HEAD"]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async getSha(cwd: string, ref: string): Promise<string> {
    const { stdout } = await this.git(cwd, ["rev-parse", ref]);
    return stdout.trim();
  }

  async isAncestor(
    cwd: string,
    ancestorSha: string,
    descendantSha: string,
  ): Promise<boolean> {
    try {
      await this.git(cwd, [
        "merge-base",
        "--is-ancestor",
        ancestorSha,
        descendantSha,
      ]);
      return true;
    } catch {
      return false;
    }
  }
}
