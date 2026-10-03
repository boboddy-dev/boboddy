/**
 * `checkoutBase` fetch-skipping behavior of {@link GitCliCommitPushService}
 * against REAL temp git repos. "Does not fetch" is asserted by repointing
 * `origin` at a path that does not exist, so any fetch would fail.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { setupCachedCloneFixture } from "./cached-git-clone-fixtures";
import { git, writeRepoFile } from "./git-test-fixtures";

async function setupFixture(): Promise<{
  root: string;
  remote: string;
  workspace: string;
  publishBranch: (branchName: string) => Promise<string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-checkout-base-"));
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  const seed = path.join(root, "seed");

  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare", "-b", "main"]);
  await git(root, ["clone", remote, seed]);
  await git(seed, ["config", "user.email", "seed@boboddy.dev"]);
  await git(seed, ["config", "user.name", "Seed"]);
  await writeRepoFile(seed, "README.md", "hello\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--no-gpg-sign", "-m", "init"]);
  await git(seed, ["push", "origin", "main"]);

  async function publishBranch(branchName: string): Promise<string> {
    await git(seed, ["checkout", "-B", branchName, "main"]);
    await writeRepoFile(seed, `${branchName}.txt`, `${branchName}\n`);
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--no-gpg-sign", "-m", branchName]);
    await git(seed, ["push", "origin", branchName]);
    return git(seed, ["rev-parse", "HEAD"]);
  }

  return { root, remote, workspace, publishBranch };
}

async function captureError(action: Promise<unknown>): Promise<Error> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the action to reject");
}

async function breakOrigin(workspace: string, root: string): Promise<void> {
  await git(workspace, [
    "remote",
    "set-url",
    "origin",
    path.join(root, "does-not-exist.git"),
  ]);
}

describe("GitCliCommitPushService.checkoutBase fetch behavior", () => {
  const service = new GitCliCommitPushService();

  test.concurrent(
    "does not fetch when refs/remotes/origin/<branch> already resolves",
    async () => {
      const fx = await setupFixture();
      try {
        const sha = await fx.publishBranch("boboddy/prev-step");
        await git(fx.root, ["clone", fx.remote, fx.workspace]);
        await breakOrigin(fx.workspace, fx.root);

        await service.checkoutBase({
          workspacePath: fx.workspace,
          baseWorkBranch: "boboddy/prev-step",
        });

        expect(await git(fx.workspace, ["branch", "--show-current"])).toBe(
          "boboddy/prev-step",
        );
        expect(await git(fx.workspace, ["rev-parse", "HEAD"])).toBe(sha);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "fetches when the remote-tracking ref is missing and the branch exists on the remote",
    async () => {
      const fx = await setupFixture();
      try {
        await git(fx.root, ["clone", fx.remote, fx.workspace]);
        const sha = await fx.publishBranch("boboddy/late-step");
        await captureError(
          git(fx.workspace, [
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/remotes/origin/boboddy/late-step",
          ]),
        );

        await service.checkoutBase({
          workspacePath: fx.workspace,
          baseWorkBranch: "boboddy/late-step",
        });

        expect(await git(fx.workspace, ["branch", "--show-current"])).toBe(
          "boboddy/late-step",
        );
        expect(await git(fx.workspace, ["rev-parse", "HEAD"])).toBe(sha);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "errors from the fetch when the branch is missing locally and on the remote",
    async () => {
      const fx = await setupFixture();
      try {
        await git(fx.root, ["clone", fx.remote, fx.workspace]);

        const error = await captureError(
          service.checkoutBase({
            workspacePath: fx.workspace,
            baseWorkBranch: "boboddy/never-pushed",
          }),
        );

        expect(error.message).toMatch(
          /couldn't find remote ref boboddy\/never-pushed/,
        );
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "errors from the fetch when the ref is missing and the remote is unreachable",
    async () => {
      const fx = await setupFixture();
      try {
        await git(fx.root, ["clone", fx.remote, fx.workspace]);
        await breakOrigin(fx.workspace, fx.root);

        const error = await captureError(
          service.checkoutBase({
            workspacePath: fx.workspace,
            baseWorkBranch: "boboddy/never-pushed",
          }),
        );

        expect(error.message).toContain("fetch origin boboddy/never-pushed");
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "checks out a non-default branch of a mirror-backed clone without a fetch",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await git(fx.seed, ["checkout", "-b", "boboddy/prev-step"]);
        const sha = await fx.commit("prev-step");
        await git(fx.seed, ["push", "origin", "boboddy/prev-step"]);

        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });
        expect(fx.fallback.calls).toHaveLength(0);
        await breakOrigin(fx.workspacePath, fx.root);

        await service.checkoutBase({
          workspacePath: fx.workspacePath,
          baseWorkBranch: "boboddy/prev-step",
        });

        expect(await git(fx.workspacePath, ["branch", "--show-current"])).toBe(
          "boboddy/prev-step",
        );
        expect(await git(fx.workspacePath, ["rev-parse", "HEAD"])).toBe(sha);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );
});
