/**
 * Unit tests for {@link GitCliSourceBranchPort} against REAL temp git repos,
 * mirroring `git-cli-commit-push-service.test.ts`'s style: a bare "remote"
 * repo on local disk stands in for `origin` so `fetch` works without network
 * access.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitCliSourceBranchPort } from "../../../../src/project/source-branch/infra/git-cli-source-branch-port";

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

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", message]);
}

describe("GitCliSourceBranchPort", () => {
  let root: string;
  let remote: string;
  let workspace: string;
  const port = new GitCliSourceBranchPort();

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "git-source-branch-"));
    remote = path.join(root, "remote.git");
    workspace = path.join(root, "workspace");

    await mkdir(remote, { recursive: true });
    await git(remote, ["init", "--bare", "-b", "main"]);

    const seed = path.join(root, "seed");
    await git(root, ["clone", remote, seed]);
    await git(seed, ["config", "user.email", "seed@boboddy.dev"]);
    await git(seed, ["config", "user.name", "Seed"]);
    await writeRepoFile(seed, "README.md", "hello\n");
    await commitAll(seed, "init");
    await git(seed, ["push", "origin", "main"]);

    await git(root, ["clone", remote, workspace]);
    await git(workspace, ["config", "user.email", "workspace@boboddy.dev"]);
    await git(workspace, ["config", "user.name", "Workspace"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("isGitRepository is true inside a working tree and false elsewhere", async () => {
    expect(await port.isGitRepository(workspace)).toBe(true);
    expect(await port.isGitRepository(os.tmpdir())).toBe(false);
  });

  test("getCurrentBranch returns the checked-out branch name", async () => {
    await git(workspace, ["checkout", "-b", "feature-x"]);
    expect(await port.getCurrentBranch(workspace)).toBe("feature-x");
  });

  test("getCurrentBranch returns null on detached HEAD", async () => {
    const headSha = await git(workspace, ["rev-parse", "HEAD"]);
    await git(workspace, ["checkout", headSha]);
    expect(await port.getCurrentBranch(workspace)).toBeNull();
  });

  test("fetchRemoteBranchSha returns null when the branch does not exist on origin", async () => {
    expect(
      await port.fetchRemoteBranchSha(workspace, "does-not-exist"),
    ).toBeNull();
  });

  test("fetchRemoteBranchSha returns the remote SHA without checking out or moving local refs", async () => {
    // Publish "feature-x" to the remote from a separate clone.
    const other = path.join(root, "other");
    await git(root, ["clone", remote, other]);
    await git(other, ["config", "user.email", "other@boboddy.dev"]);
    await git(other, ["config", "user.name", "Other"]);
    await git(other, ["checkout", "-b", "feature-x"]);
    await writeRepoFile(other, "feature.txt", "feature\n");
    await commitAll(other, "feature");
    await git(other, ["push", "origin", "feature-x"]);
    const remoteSha = await git(other, ["rev-parse", "feature-x"]);

    const branchBefore = await git(workspace, ["branch", "--show-current"]);
    expect(await port.fetchRemoteBranchSha(workspace, "feature-x")).toBe(
      remoteSha,
    );
    // Fetching into FETCH_HEAD must not touch the currently checked-out branch.
    expect(await git(workspace, ["branch", "--show-current"])).toBe(
      branchBefore,
    );
  });

  test("getSha resolves HEAD to the current commit", async () => {
    const expected = await git(workspace, ["rev-parse", "HEAD"]);
    expect(await port.getSha(workspace, "HEAD")).toBe(expected);
  });

  test("isAncestor is true when the first SHA precedes the second", async () => {
    const baseSha = await git(workspace, ["rev-parse", "HEAD"]);
    await writeRepoFile(workspace, "more.txt", "more\n");
    await commitAll(workspace, "more");
    const headSha = await git(workspace, ["rev-parse", "HEAD"]);

    expect(await port.isAncestor(workspace, baseSha, headSha)).toBe(true);
    expect(await port.isAncestor(workspace, headSha, baseSha)).toBe(false);
  });
});
