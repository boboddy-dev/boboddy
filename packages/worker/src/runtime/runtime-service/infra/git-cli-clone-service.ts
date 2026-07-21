import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../application/git-clone-service";
import { noopLogger, type Logger } from "../../../lib/logger";

const execFileAsync = promisify(execFile);

async function resolveBranchName(workspacePath: string): Promise<string> {
  const commands = [
    ["-C", workspacePath, "branch", "--show-current"],
    ["-C", workspacePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
    ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"],
  ] as const;

  for (const args of commands) {
    try {
      const { stdout } = await execFileAsync("git", [...args]);
      const branch = stdout.trim();
      if (branch && branch !== "HEAD") {
        return branch;
      }
    } catch {
      // Try the next strategy.
    }
  }

  throw new Error(
    `Could not resolve cloned branch for workspace ${workspacePath}`,
  );
}

export class GitCliCloneService implements GitCloneService {
  constructor(private readonly logger: Logger = noopLogger) {}

  async cloneRepository(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    // Always clone the repo's default HEAD. When a step needs a different base
    // branch, the caller checks it out after clone (see prepareWorkBranch).
    const args = ["clone", "--origin", "origin", "--no-tags"];

    args.push(input.gitUrl, input.workspacePath);

    try {
      await execFileAsync("git", args);
      return {
        resolvedBranch: await resolveBranchName(input.workspacePath),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to clone runtime session repository: ${message}`,
        { cause: error },
      );
    }
  }
}
