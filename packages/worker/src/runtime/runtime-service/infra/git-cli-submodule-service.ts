import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  DetectSubmodulesInput,
  SubmoduleService,
} from "../application/submodule-service";
import { parseSubmoduleStatus, type SubmoduleInfo } from "../domain/submodules";
import { noopLogger, type Logger } from "../../../lib/logger";

const execFileAsync = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/**
 * Host-side, read-only detection of a repository's top-level git submodules via
 * `git submodule status`. Runs against the bind-mounted workspace on the worker
 * machine (never inside the container). Submodules are NOT recursed into.
 *
 * A repository with no `.gitmodules` exits 0 with empty output, so the common
 * "no submodules" case is a plain empty result, not an error.
 */
export class GitCliSubmoduleService implements SubmoduleService {
  constructor(private readonly logger: Logger = noopLogger) {}

  async detectSubmodules(
    input: DetectSubmodulesInput,
  ): Promise<SubmoduleInfo[]> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", input.workspacePath, "submodule", "status"],
        { env: gitEnv() },
      );
      return parseSubmoduleStatus(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to detect submodules for workspace ${input.workspacePath}: ${message}`,
        { cause: error },
      );
    }
  }
}
