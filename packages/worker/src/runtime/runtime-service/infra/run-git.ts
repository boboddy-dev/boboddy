import { execFile } from "node:child_process";
import { GitCommandError } from "./git-failure";

export type RunGitOptions = { label: string; timeoutMs: number };

/** Runs `git <args>` and resolves with stdout. Injectable for fault tests. */
export type GitRunner = (
  args: string[],
  options: RunGitOptions,
) => Promise<string>;

/**
 * Runs `git` non-interactively (`GIT_TERMINAL_PROMPT=0`). A failure rejects with
 * a {@link GitCommandError} that carries the full stderr and exit code.
 */
export const runGit: GitRunner = (args, options) => {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const timedOut = "killed" in error && error.killed === true;
        const detail = timedOut
          ? `timed out after ${String(options.timeoutMs)}ms`
          : lastLines(stderr) || error.message.split("\n")[0] || "";
        const exitCode = typeof error.code === "number" ? error.code : null;
        reject(
          new GitCommandError(
            `git ${options.label} failed: ${detail}`,
            stderr,
            timedOut ? null : exitCode,
          ),
        );
      },
    );
  });
};

function lastLines(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-3)
    .join("; ");
}
