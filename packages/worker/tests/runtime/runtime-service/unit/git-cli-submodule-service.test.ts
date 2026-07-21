/**
 * Integration tests for {@link GitCliSubmoduleService} against REAL temp git
 * repos. A local-path submodule is added to a superproject; local-file
 * submodule transport requires `protocol.file.allow=always` on modern git, so
 * the setup passes it per-invocation. This mirrors the real-temp-repo style of
 * git-cli-commit-push-service.test.ts. No Docker is used.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitCliSubmoduleService } from "../../../../src/runtime/runtime-service/infra/git-cli-submodule-service";

const execFileAsync = promisify(execFile);

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: GIT_ENV,
  });
  return stdout.trim();
}

async function writeRepoFile(
  repo: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const abs = path.join(repo, relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

async function initRepoWithCommit(
  repo: string,
  name: string,
): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", `${name}@boboddy.dev`]);
  await git(repo, ["config", "user.name", name]);
  await writeRepoFile(repo, "README.md", `${name}\n`);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", "init"]);
}

describe("GitCliSubmoduleService", () => {
  let root: string;
  let superproject: string;
  let submoduleSource: string;
  const service = new GitCliSubmoduleService();

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "git-submodule-"));
    superproject = path.join(root, "superproject");
    submoduleSource = path.join(root, "submodule-src");

    await initRepoWithCommit(superproject, "Super");
    await initRepoWithCommit(submoduleSource, "Sub");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("detects an added submodule as initialized:true", async () => {
    await git(superproject, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleSource,
      "vendor/dep",
    ]);
    await git(superproject, ["commit", "--no-gpg-sign", "-m", "add submodule"]);

    const result = await service.detectSubmodules({
      workspacePath: superproject,
    });

    expect(result).toEqual([{ path: "vendor/dep", initialized: true }]);
  });

  test("returns [] for a repo with no submodules", async () => {
    const result = await service.detectSubmodules({
      workspacePath: superproject,
    });
    expect(result).toEqual([]);
  });

  test("reports initialized:false for an uninitialized submodule", async () => {
    await git(superproject, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleSource,
      "vendor/dep",
    ]);
    await git(superproject, ["commit", "--no-gpg-sign", "-m", "add submodule"]);

    // Fresh clone WITHOUT --recurse-submodules leaves the submodule uninitialized.
    const fresh = path.join(root, "fresh");
    await git(root, [
      "-c",
      "protocol.file.allow=always",
      "clone",
      superproject,
      fresh,
    ]);

    const result = await service.detectSubmodules({ workspacePath: fresh });
    expect(result).toEqual([{ path: "vendor/dep", initialized: false }]);
  });
});
