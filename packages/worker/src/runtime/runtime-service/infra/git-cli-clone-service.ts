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
    const args = ["clone", "--origin", "origin", "--no-tags"];

    if (input.requestedBranch?.trim()) {
      args.push("--branch", input.requestedBranch.trim(), "--single-branch");
    }

    args.push(input.gitUrl, input.workspacePath);

    const log = this.logger.child({ scope: "GitCliCloneService" });

    try {
      await execFileAsync("git", args);
      log.info(
        { workspacePath: input.workspacePath },
        "initializing submodules",
      );
      // await execFileAsync(
      //   "git",
      //   [
      //     "-C",
      //     input.workspacePath,
      //     "submodule",
      //     "update",
      //     "--init",
      //     "--recursive",
      //   ],
      //   { timeout: 60_000 },
      // );
      log.info(
        { workspacePath: input.workspacePath },
        "submodules initialized",
      );
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
