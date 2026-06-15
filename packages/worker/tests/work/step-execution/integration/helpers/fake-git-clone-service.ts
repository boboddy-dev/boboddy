import { execFile } from "node:child_process";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../../../../../src/runtime/runtime-service/application/git-clone-service";

export type { CloneRepositoryInput, CloneRepositoryResult };

const execFileAsync = promisify(execFile);

const DUMMY_REPO_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dummy-repo",
);

const DEFAULT_BRANCH = "main";

/**
 * Test double for the production GitCliCloneService. Instead of cloning over
 * the network, it copies the bundled dummy repo fixture into the workspace and
 * initializes a real local git repo (so resolveBranchName and any downstream
 * git expectations are satisfied). No network access required.
 */
export class FakeGitCloneService implements GitCloneService {
  constructor(private readonly sourceRepoDir: string = DUMMY_REPO_DIR) {}

  async cloneRepository(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    // The workspace directory already exists (created by the workspace
    // manager); copy the fixture contents into it.
    await cp(this.sourceRepoDir, input.workspacePath, {
      recursive: true,
      force: true,
    });

    const branch = input.requestedBranch?.trim() || DEFAULT_BRANCH;

    await this.git(input.workspacePath, ["init", "-b", branch]);
    await this.git(input.workspacePath, [
      "config",
      "user.email",
      "integration@boboddy.dev",
    ]);
    await this.git(input.workspacePath, [
      "config",
      "user.name",
      "Boboddy Integration",
    ]);
    await this.git(input.workspacePath, ["add", "-A"]);
    await this.git(input.workspacePath, [
      "commit",
      "--no-gpg-sign",
      "-m",
      "Initial dummy commit",
    ]);

    return { resolvedBranch: branch };
  }

  private async git(workspacePath: string, args: string[]): Promise<void> {
    await execFileAsync("git", ["-C", workspacePath, ...args], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  }
}
