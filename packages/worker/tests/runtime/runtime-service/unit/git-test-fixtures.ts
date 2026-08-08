/**
 * Shared low-level git primitives for the runtime-service git test suites
 * (git-cli-commit-push-service, git-cli-commit-push-submodule,
 * git-cli-submodule-service). Each suite builds its own fully-local,
 * per-test fixture (see each file's `setupFixture` function) so this module
 * only holds the two helpers that were duplicated verbatim across all three:
 * running a `git` CLI command and writing a file into a repo.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: GIT_ENV,
  });
  return stdout.trim();
}

export async function writeRepoFile(
  repo: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const abs = path.join(repo, relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}
