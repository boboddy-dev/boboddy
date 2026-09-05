import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../application/git-clone-service";
import { noopLogger, type Logger } from "@boboddy/observability/logging/host";

const execFileAsync = promisify(execFile);

/** Force non-interactive auth failures instead of a hung credential prompt. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/**
 * Backstop for a stalled transfer (e.g. a dead TCP connection after a network
 * path change): abort if no data arrives for this many seconds, on top of
 * `execFileAsync`'s own hard wall-clock timeout below.
 */
const CLONE_LOW_SPEED_TIME_SECONDS = 60;
const CLONE_LOW_SPEED_LIMIT_BYTES_PER_SEC = 1000;
const CLONE_TIMEOUT_MS = 10 * 60_000;

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
    const args = [
      "-c",
      `http.lowSpeedLimit=${String(CLONE_LOW_SPEED_LIMIT_BYTES_PER_SEC)}`,
      "-c",
      `http.lowSpeedTime=${String(CLONE_LOW_SPEED_TIME_SECONDS)}`,
      "clone",
      "--origin",
      "origin",
      "--no-tags",
    ];

    args.push(input.gitUrl, input.workspacePath);

    try {
      await execFileAsync("git", args, {
        env: gitEnv(),
        timeout: CLONE_TIMEOUT_MS,
      });
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
