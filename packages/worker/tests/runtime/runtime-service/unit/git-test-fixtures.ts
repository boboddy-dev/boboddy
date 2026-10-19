/**
 * Shared low-level git primitives for the runtime-service git test suites
 * (git-cli-commit-push-service, git-cli-commit-push-submodule, the
 * mirror-cache suites): running a `git` CLI command, writing a file into a
 * repo, and {@link GitFixtureTemplate} for building a fixture tree once per
 * file and copying it per test.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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

/**
 * A git fixture tree built lazily on the first {@link copy} and then copied
 * into a fresh temp dir for every test, so tests never share mutable state
 * but pay for `git init`/commit/push only once per file. Each test file that
 * uses one calls {@link dispose} from `afterAll`.
 *
 * A copy is byte-for-byte, so anything in the tree that embeds an absolute
 * path (a clone's `remote.origin.url`, an absolute submodule URL) still points
 * at the template; callers keep the template to bare repos or fix those paths
 * up after copying.
 */
export class GitFixtureTemplate {
  private template: Promise<string> | undefined;

  constructor(
    private readonly prefix: string,
    private readonly build: (dir: string) => Promise<void>,
  ) {}

  async copy(): Promise<string> {
    this.template ??= this.create();
    const template = await this.template;
    const root = await mkdtemp(path.join(os.tmpdir(), `${this.prefix}-`));
    await cp(template, root, { recursive: true });
    return root;
  }

  async dispose(): Promise<void> {
    const template = await this.template?.catch(() => undefined);
    this.template = undefined;
    if (template !== undefined) {
      await rm(template, { recursive: true, force: true });
    }
  }

  private async create(): Promise<string> {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), `${this.prefix}-template-`),
    );
    await this.build(dir);
    return dir;
  }
}
