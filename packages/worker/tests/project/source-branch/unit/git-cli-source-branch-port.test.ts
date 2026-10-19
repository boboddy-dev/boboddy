/**
 * Unit tests for {@link GitCliSourceBranchPort} against REAL temp git repos,
 * mirroring `git-cli-commit-push-service.test.ts`'s style: a bare "remote"
 * repo on local disk stands in for `origin` so `fetch` works without network
 * access. The repos are built once per file and copied for every test, so the
 * tests share no mutable state and run concurrently.
 */
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { GitCliSourceBranchPort } from "../../../../src/project/source-branch/infra/git-cli-source-branch-port";
import {
  git,
  GitFixtureTemplate,
  writeRepoFile,
} from "../../../runtime/runtime-service/unit/git-test-fixtures";

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", message]);
}

const template = new GitFixtureTemplate("git-source-branch", async (dir) => {
  const remote = path.join(dir, "remote.git");
  await git(dir, ["init", "--bare", "-b", "main", remote]);

  const seed = path.join(dir, "seed");
  await git(dir, ["clone", remote, seed]);
  await git(seed, ["config", "user.email", "seed@boboddy.dev"]);
  await git(seed, ["config", "user.name", "Seed"]);
  await writeRepoFile(seed, "README.md", "hello\n");
  await commitAll(seed, "init");
  await git(seed, ["push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });

  const workspace = path.join(dir, "workspace");
  await git(dir, ["clone", remote, workspace]);
  await git(workspace, ["config", "user.email", "workspace@boboddy.dev"]);
  await git(workspace, ["config", "user.name", "Workspace"]);
});

type Fixture = { root: string; remote: string; workspace: string };

/**
 * Runs `body` against a fresh copy of the template: a bare `remote.git` with
 * one commit on `main` and a `workspace` clone of it, whose `origin` is
 * repointed from the template's remote to the copy's.
 */
async function withFixture(body: (fx: Fixture) => Promise<void>) {
  const root = await template.copy();
  try {
    const remote = path.join(root, "remote.git");
    const workspace = path.join(root, "workspace");
    await git(workspace, ["remote", "set-url", "origin", remote]);
    await body({ root, remote, workspace });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

afterAll(() => template.dispose());

describe("GitCliSourceBranchPort", () => {
  const port = new GitCliSourceBranchPort();

  test.concurrent(
    "isGitRepository is true inside a working tree and false elsewhere",
    () =>
      withFixture(async ({ workspace }) => {
        expect(await port.isGitRepository(workspace)).toBe(true);
        expect(await port.isGitRepository(os.tmpdir())).toBe(false);
      }),
  );

  test.concurrent("getCurrentBranch returns the checked-out branch name", () =>
    withFixture(async ({ workspace }) => {
      await git(workspace, ["checkout", "-b", "feature-x"]);
      expect(await port.getCurrentBranch(workspace)).toBe("feature-x");
    }),
  );

  test.concurrent("getCurrentBranch returns null on detached HEAD", () =>
    withFixture(async ({ workspace }) => {
      const headSha = await git(workspace, ["rev-parse", "HEAD"]);
      await git(workspace, ["checkout", headSha]);
      expect(await port.getCurrentBranch(workspace)).toBeNull();
    }),
  );

  test.concurrent(
    "fetchRemoteBranchSha returns null when the branch does not exist on origin",
    () =>
      withFixture(async ({ workspace }) => {
        expect(
          await port.fetchRemoteBranchSha(workspace, "does-not-exist"),
        ).toBeNull();
      }),
  );

  test.concurrent(
    "fetchRemoteBranchSha returns the remote SHA without checking out or moving local refs",
    () =>
      withFixture(async ({ root, remote, workspace }) => {
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
      }),
  );

  test.concurrent("getSha resolves HEAD to the current commit", () =>
    withFixture(async ({ workspace }) => {
      const expected = await git(workspace, ["rev-parse", "HEAD"]);
      expect(await port.getSha(workspace, "HEAD")).toBe(expected);
    }),
  );

  test.concurrent(
    "isAncestor is true when the first SHA precedes the second",
    () =>
      withFixture(async ({ workspace }) => {
        const baseSha = await git(workspace, ["rev-parse", "HEAD"]);
        await writeRepoFile(workspace, "more.txt", "more\n");
        await commitAll(workspace, "more");
        const headSha = await git(workspace, ["rev-parse", "HEAD"]);

        expect(await port.isAncestor(workspace, baseSha, headSha)).toBe(true);
        expect(await port.isAncestor(workspace, headSha, baseSha)).toBe(false);
      }),
  );
});
