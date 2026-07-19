/**
 * Unit tests for {@link GitCliCommitPushService} against REAL temp git repos.
 *
 * A bare "remote" repo is created so `push` works without network access, then a
 * working clone is made from it. This mirrors the fake-git-clone-service style
 * (real git, identity configured, GIT_TERMINAL_PROMPT=0). No Docker is used; the
 * EACCES retry path is exercised via an injected git double rather than real
 * root-owned files (explained inline).
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { WORK_BRANCH_EXCLUDE_PATHS } from "../../../../src/work/step-execution/infra/work-branch-manager";

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

describe("GitCliCommitPushService", () => {
  let root: string;
  let remote: string;
  let workspace: string;
  const service = new GitCliCommitPushService();

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "git-commit-push-"));
    remote = path.join(root, "remote.git");
    workspace = path.join(root, "workspace");

    // Bare remote with an initial commit on `main`.
    await mkdir(remote, { recursive: true });
    await git(remote, ["init", "--bare", "-b", "main"]);

    // Seed the remote by cloning, committing, and pushing an initial file.
    const seed = path.join(root, "seed");
    await git(root, ["clone", remote, seed]);
    await git(seed, ["config", "user.email", "seed@boboddy.dev"]);
    await git(seed, ["config", "user.name", "Seed"]);
    await writeRepoFile(seed, "README.md", "hello\n");
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--no-gpg-sign", "-m", "init"]);
    await git(seed, ["push", "origin", "main"]);

    // The working clone the service operates against. Configure a local git
    // identity so raw `git commit` calls in test setup succeed in CI, where no
    // global identity exists. (The service itself injects identity per-invocation
    // via `-c user.name/-c user.email`, so it does not rely on this.)
    await git(root, ["clone", remote, workspace]);
    await git(workspace, ["config", "user.email", "workspace@boboddy.dev"]);
    await git(workspace, ["config", "user.name", "Workspace"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("createBranch branches off the current (clone base) branch", async () => {
    await service.createBranch({
      workspacePath: workspace,
      branchName: "boboddy/step-1",
    });
    expect(await git(workspace, ["branch", "--show-current"])).toBe(
      "boboddy/step-1",
    );
  });

  test("checkoutBase fetches and checks out a previous work branch", async () => {
    // Publish a prior work branch to the remote from a separate clone.
    const prior = path.join(root, "prior");
    await git(root, ["clone", remote, prior]);
    await git(prior, ["config", "user.email", "prior@boboddy.dev"]);
    await git(prior, ["config", "user.name", "Prior"]);
    await git(prior, ["checkout", "-b", "boboddy/prev-step"]);
    await writeRepoFile(prior, "prev.txt", "prev\n");
    await git(prior, ["add", "-A"]);
    await git(prior, ["commit", "--no-gpg-sign", "-m", "prev"]);
    await git(prior, ["push", "--set-upstream", "origin", "boboddy/prev-step"]);

    await service.checkoutBase({
      workspacePath: workspace,
      baseWorkBranch: "boboddy/prev-step",
    });

    expect(await git(workspace, ["branch", "--show-current"])).toBe(
      "boboddy/prev-step",
    );
    // The prior step's file is present on the checked-out base.
    expect(await git(workspace, ["log", "--oneline"])).toContain("prev");
  });

  test("commitAll excludes the Boboddy runtime files (untracked)", async () => {
    await service.createBranch({
      workspacePath: workspace,
      branchName: "boboddy/step-2",
    });

    await writeRepoFile(workspace, "src/app.ts", "export const x = 1;\n");
    for (const excluded of WORK_BRANCH_EXCLUDE_PATHS) {
      await writeRepoFile(workspace, excluded, "SHOULD NOT COMMIT\n");
    }

    const result = await service.commitAll({
      workspacePath: workspace,
      message: "boboddy: step 2",
      excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
    });
    expect(result.committed).toBe(true);

    const committedFiles = await git(workspace, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    expect(committedFiles).toContain("src/app.ts");
    for (const excluded of WORK_BRANCH_EXCLUDE_PATHS) {
      expect(committedFiles).not.toContain(excluded);
    }
  });

  test("commitAll excludes the Boboddy runtime files even when tracked+modified", async () => {
    // Track the exclude paths on the base branch first (a prior legitimate commit).
    for (const excluded of WORK_BRANCH_EXCLUDE_PATHS) {
      await writeRepoFile(workspace, excluded, "original\n");
    }
    await git(workspace, ["add", "-A"]);
    await git(workspace, ["commit", "--no-gpg-sign", "-m", "track boboddy files"]);

    await service.createBranch({
      workspacePath: workspace,
      branchName: "boboddy/step-3",
    });

    // Now MODIFY the tracked exclude paths + add a real change.
    for (const excluded of WORK_BRANCH_EXCLUDE_PATHS) {
      await writeRepoFile(workspace, excluded, "MODIFIED BY AGENT\n");
    }
    await writeRepoFile(workspace, "src/feature.ts", "export const y = 2;\n");

    const result = await service.commitAll({
      workspacePath: workspace,
      message: "boboddy: step 3",
      excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
    });
    expect(result.committed).toBe(true);

    const committedFiles = await git(workspace, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    expect(committedFiles).toContain("src/feature.ts");
    for (const excluded of WORK_BRANCH_EXCLUDE_PATHS) {
      expect(committedFiles).not.toContain(excluded);
    }
    // The tracked exclude paths are restored to HEAD (no lingering modification).
    expect(await git(workspace, ["status", "--porcelain"])).toBe("");
  });

  test("commitAll returns committed:false when there is nothing to commit", async () => {
    await service.createBranch({
      workspacePath: workspace,
      branchName: "boboddy/step-4",
    });
    // Only runtime files present — all excluded, so nothing to commit.
    for (const excluded of WORK_BRANCH_EXCLUDE_PATHS) {
      await writeRepoFile(workspace, excluded, "runtime\n");
    }

    const result = await service.commitAll({
      workspacePath: workspace,
      message: "boboddy: step 4",
      excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
    });
    expect(result.committed).toBe(false);
  });

  test("push sets the upstream to origin/<branch> and publishes the commit", async () => {
    await service.createBranch({
      workspacePath: workspace,
      branchName: "boboddy/step-5",
    });
    await writeRepoFile(workspace, "src/push.ts", "export const z = 3;\n");
    await service.commitAll({
      workspacePath: workspace,
      message: "boboddy: step 5",
      excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
    });

    await service.push({
      workspacePath: workspace,
      branchName: "boboddy/step-5",
    });

    // Upstream is configured.
    expect(
      await git(workspace, [
        "rev-parse",
        "--abbrev-ref",
        "boboddy/step-5@{upstream}",
      ]),
    ).toBe("origin/boboddy/step-5");

    // The branch exists on the remote with the same tip.
    const localTip = await git(workspace, ["rev-parse", "boboddy/step-5"]);
    const remoteTip = await git(remote, ["rev-parse", "boboddy/step-5"]);
    expect(remoteTip).toBe(localTip);
  });

  test("retries once via the chmod fallback on a permission error", async () => {
    // Full simulation of root-owned files would require Docker + real root
    // ownership, which is impractical/non-hermetic here. Instead we exercise the
    // exact retry contract: a subclass whose git runner throws EACCES on the
    // FIRST `add`, plus an injected chmod-fallback spy. The service must run the
    // fallback once and re-run `add`, then complete the real commit. `git` is
    // `protected` precisely to make this test seam possible.
    let addAttempts = 0;
    let chmodCount = 0;

    class RetryProbeService extends GitCliCommitPushService {
      protected override async git(
        workspacePath: string,
        args: readonly string[],
      ): Promise<{ stdout: string; stderr: string }> {
        if (args[0] === "add") {
          addAttempts += 1;
          if (addAttempts === 1) {
            const error = new Error(
              "permission denied",
            ) as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }
        }
        return await super.git(workspacePath, args);
      }
    }

    const probe = new RetryProbeService(undefined, () => {
      chmodCount += 1;
      return Promise.resolve();
    });

    await probe.createBranch({
      workspacePath: workspace,
      branchName: "boboddy/step-6",
    });
    await writeRepoFile(workspace, "src/retry.ts", "export const r = 4;\n");

    const result = await probe.commitAll({
      workspacePath: workspace,
      message: "boboddy: step 6",
      excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
    });

    expect(result.committed).toBe(true);
    // First `add` failed with EACCES → chmod fallback ran once → `add` retried.
    expect(addAttempts).toBe(2);
    expect(chmodCount).toBe(1);
  });
});
