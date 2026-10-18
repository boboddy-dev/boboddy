import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REJECT_ALL_PUSHES_HOOK = `#!/bin/sh
echo "push rejected by the integration test remote" >&2
exit 1
`;

/**
 * A local bare repository standing in for the project's remote, so the work
 * branch push in an integration run is a real `git push`. Seeded from the first
 * clone's `main`. With `rejectPushes` it refuses every later push, which is how
 * a test makes the remote unwritable.
 */
export class FakeGitRemote {
  readonly dir = path.join(
    os.tmpdir(),
    `boboddy-integration-remote-${randomUUID()}.git`,
  );
  private seeded = false;

  constructor(private readonly options: { rejectPushes?: boolean } = {}) {}

  /** Points `workspacePath`'s `origin` here, seeding `main` on the first call. */
  async attach(workspacePath: string): Promise<void> {
    await this.git(workspacePath, ["remote", "add", "origin", this.dir]);
    if (this.seeded) return;
    await execFileAsync("git", ["init", "--bare", "-b", "main", this.dir]);
    await this.git(workspacePath, ["push", "origin", "main"]);
    this.seeded = true;
    if (this.options.rejectPushes) {
      const hookPath = path.join(this.dir, "hooks", "pre-receive");
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, REJECT_ALL_PUSHES_HOOK, "utf8");
      await chmod(hookPath, 0o755);
    }
  }

  async branches(): Promise<string[]> {
    const { stdout } = await execFileAsync("git", [
      "-C",
      this.dir,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    return stdout.split("\n").filter(Boolean).sort();
  }

  async commitSubject(branch: string): Promise<string> {
    const { stdout } = await execFileAsync("git", [
      "-C",
      this.dir,
      "log",
      "-1",
      "--format=%s",
      branch,
    ]);
    return stdout.trim();
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private async git(cwd: string, args: string[]): Promise<void> {
    await execFileAsync("git", ["-C", cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }
}
