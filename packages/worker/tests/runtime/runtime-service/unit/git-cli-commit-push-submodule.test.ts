/**
 * Submodule commit/branch/push behavior for {@link GitCliCommitPushService} and
 * the {@link buildCommitAndPushWorkBranch} orchestrator, against REAL temp git
 * repos. A bare remote is created per submodule so pushes work without network.
 * Local-path submodule add/clone requires `protocol.file.allow=always` on modern
 * git, so setup passes it per-invocation. Mirrors the real-temp-repo style of
 * git-cli-commit-push-service.test.ts and git-cli-submodule-service.test.ts.
 */
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { GitCliSubmoduleService } from "../../../../src/runtime/runtime-service/infra/git-cli-submodule-service";
import { buildCommitAndPushWorkBranch } from "../../../../src/work/step-execution/infra/work-branch-manager";

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

/** A bare remote seeded with one commit on `main` via a throwaway clone. */
async function createBareRemoteWithSeed(
  root: string,
  name: string,
): Promise<string> {
  const remote = path.join(root, `${name}.git`);
  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare", "-b", "main"]);

  const seed = path.join(root, `${name}-seed`);
  await git(root, ["clone", remote, seed]);
  await git(seed, ["config", "user.email", `${name}@boboddy.dev`]);
  await git(seed, ["config", "user.name", name]);
  await writeRepoFile(seed, "README.md", `${name}\n`);
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--no-gpg-sign", "-m", "init"]);
  await git(seed, ["push", "origin", "main"]);
  return remote;
}

/** Clone (recursing submodules) into a working tree with a local identity. */
async function cloneWorking(
  root: string,
  remote: string,
  name: string,
): Promise<string> {
  const workspace = path.join(root, name);
  await git(root, [
    "-c",
    "protocol.file.allow=always",
    "clone",
    "--recurse-submodules",
    remote,
    workspace,
  ]);
  await git(workspace, ["config", "user.email", "workspace@boboddy.dev"]);
  await git(workspace, ["config", "user.name", "Workspace"]);
  return workspace;
}

describe("GitCliCommitPushService submodule methods", () => {
  let root: string;
  let superRemote: string;
  let subRemote: string;
  let workspace: string;
  const service = new GitCliCommitPushService();
  const submoduleService = new GitCliSubmoduleService();

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "git-submodule-commit-"));
    subRemote = await createBareRemoteWithSeed(root, "sub");
    superRemote = await createBareRemoteWithSeed(root, "super");

    // Add the submodule to the superproject via a throwaway clone, then push.
    const superSeed = path.join(root, "super-add");
    await git(root, ["clone", superRemote, superSeed]);
    await git(superSeed, ["config", "user.email", "add@boboddy.dev"]);
    await git(superSeed, ["config", "user.name", "Add"]);
    await git(superSeed, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      subRemote,
      "vendor/dep",
    ]);
    await git(superSeed, ["commit", "--no-gpg-sign", "-m", "add submodule"]);
    await git(superSeed, ["push", "origin", "main"]);

    workspace = await cloneWorking(root, superRemote, "workspace");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("submoduleHasChanges: true when the submodule tree is dirty", async () => {
    const sub = path.join(workspace, "vendor/dep");
    await writeRepoFile(sub, "changed.ts", "export const a = 1;\n");
    expect(
      await service.submoduleHasChanges({
        workspacePath: workspace,
        submodulePath: "vendor/dep",
      }),
    ).toBe(true);
  });

  test("submoduleHasChanges: false when the submodule tree is clean", async () => {
    expect(
      await service.submoduleHasChanges({
        workspacePath: workspace,
        submodulePath: "vendor/dep",
      }),
    ).toBe(false);
  });

  test("submoduleHasChanges: false for an uninitialized submodule (no .git)", async () => {
    // Fresh clone WITHOUT recursing leaves vendor/dep uninitialized (empty, no .git).
    const bare = await cloneWorkingNoRecurse(root, superRemote, "bare");
    expect(
      await service.submoduleHasChanges({
        workspacePath: bare,
        submodulePath: "vendor/dep",
      }),
    ).toBe(false);
  });

  test("commitInSubmodule creates the branch and commits inside the submodule", async () => {
    const sub = path.join(workspace, "vendor/dep");
    await writeRepoFile(sub, "feature.ts", "export const b = 2;\n");

    const result = await service.commitInSubmodule({
      workspacePath: workspace,
      submodulePath: "vendor/dep",
      branchName: "boboddy/step-x",
      message: "boboddy: step x",
    });
    expect(result).toEqual({ committed: true, branchCreated: true });
    expect(await git(sub, ["branch", "--show-current"])).toBe("boboddy/step-x");
    expect(await git(sub, ["show", "--name-only", "--pretty=format:", "HEAD"]))
      .toContain("feature.ts");
  });

  test("pushSubmodule publishes the branch to the submodule's own origin", async () => {
    const sub = path.join(workspace, "vendor/dep");
    await writeRepoFile(sub, "pushed.ts", "export const c = 3;\n");
    await service.commitInSubmodule({
      workspacePath: workspace,
      submodulePath: "vendor/dep",
      branchName: "boboddy/step-push",
      message: "boboddy: step push",
    });

    await service.pushSubmodule({
      workspacePath: workspace,
      submodulePath: "vendor/dep",
      branchName: "boboddy/step-push",
    });

    const localTip = await git(sub, ["rev-parse", "boboddy/step-push"]);
    const remoteTip = await git(subRemote, ["rev-parse", "boboddy/step-push"]);
    expect(remoteTip).toBe(localTip);
  });

  test("pushSubmodule throws on failure (nonexistent origin) — orchestrator handles it", async () => {
    const sub = path.join(workspace, "vendor/dep");
    await writeRepoFile(sub, "orphan.ts", "export const d = 4;\n");
    await service.commitInSubmodule({
      workspacePath: workspace,
      submodulePath: "vendor/dep",
      branchName: "boboddy/step-fail",
      message: "boboddy: step fail",
    });
    // Point the submodule origin at a nonexistent bare repo.
    await git(sub, [
      "remote",
      "set-url",
      "origin",
      path.join(root, "does-not-exist.git"),
    ]);

    let threw = false;
    try {
      await service.pushSubmodule({
        workspacePath: workspace,
        submodulePath: "vendor/dep",
        branchName: "boboddy/step-fail",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  describe("buildCommitAndPushWorkBranch orchestration", () => {
    async function runClosure(workBranch: string): Promise<void> {
      await service.createBranch({ workspacePath: workspace, branchName: workBranch });
      const closure = buildCommitAndPushWorkBranch({
        gitCommitPushService: service,
        submoduleService,
        workspacePath: workspace,
        workBranch,
        stepExecutionId: "step-exec-1",
      });
      await closure();
    }

    test("submodule WITH changes → branch/commit/push + superproject records gitlink", async () => {
      const sub = path.join(workspace, "vendor/dep");
      await writeRepoFile(sub, "agent.ts", "export const e = 5;\n");

      const gitlinkBefore = await git(workspace, ["rev-parse", "HEAD:vendor/dep"]);
      await runClosure("boboddy/with-changes");

      // Submodule branch created + pushed.
      expect(await git(sub, ["branch", "--list", "boboddy/with-changes"]))
        .toContain("boboddy/with-changes");
      const subLocal = await git(sub, ["rev-parse", "boboddy/with-changes"]);
      const subRemoteTip = await git(subRemote, ["rev-parse", "boboddy/with-changes"]);
      expect(subRemoteTip).toBe(subLocal);

      // Superproject work-branch commit records the updated gitlink.
      const gitlinkAfter = await git(workspace, ["rev-parse", "HEAD:vendor/dep"]);
      expect(gitlinkAfter).not.toBe(gitlinkBefore);
      expect(gitlinkAfter).toBe(subLocal);
    });

    test("submodule with NO changes → no branch, gitlink unchanged", async () => {
      // Only a superproject-level change; submodule tree stays clean.
      await writeRepoFile(workspace, "top.ts", "export const f = 6;\n");
      const sub = path.join(workspace, "vendor/dep");
      const gitlinkBefore = await git(workspace, ["rev-parse", "HEAD:vendor/dep"]);

      await runClosure("boboddy/no-changes");

      expect(await git(sub, ["branch", "--list", "boboddy/no-changes"])).toBe("");
      const gitlinkAfter = await git(workspace, ["rev-parse", "HEAD:vendor/dep"]);
      expect(gitlinkAfter).toBe(gitlinkBefore);
      // The superproject change was still committed.
      expect(await git(workspace, ["show", "--name-only", "--pretty=format:", "HEAD"]))
        .toContain("top.ts");
    });

    test("uninitialized submodule → skipped, no branch, no error", async () => {
      const bare = await cloneWorkingNoRecurse(root, superRemote, "bare-orch");
      await writeRepoFile(bare, "top.ts", "export const g = 7;\n");

      await service.createBranch({ workspacePath: bare, branchName: "boboddy/uninit" });
      const closure = buildCommitAndPushWorkBranch({
        gitCommitPushService: service,
        submoduleService,
        workspacePath: bare,
        workBranch: "boboddy/uninit",
        stepExecutionId: "step-exec-uninit",
      });
      await closure();

      // The uninitialized submodule dir has no `.git`, so it was never branched
      // or committed (a `git -C <sub>` would resolve up to the superproject repo,
      // so we assert on the filesystem instead of `git branch`).
      const subGit = path.join(bare, "vendor/dep", ".git");
      let dotGitExists = true;
      try {
        await access(subGit);
      } catch {
        dotGitExists = false;
      }
      expect(dotGitExists).toBe(false);
      // The superproject change was still committed.
      expect(await git(bare, ["show", "--name-only", "--pretty=format:", "HEAD"]))
        .toContain("top.ts");
    });

    test("submodule push FAILURE → step succeeds, failed gitlink excluded, sibling recorded", async () => {
      // Add a SECOND submodule that will push successfully.
      const sib = await createBareRemoteWithSeed(root, "sib");
      const superSeed2 = path.join(root, "super-add2");
      await git(root, ["clone", superRemote, superSeed2]);
      await git(superSeed2, ["config", "user.email", "add2@boboddy.dev"]);
      await git(superSeed2, ["config", "user.name", "Add2"]);
      await git(superSeed2, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        sib,
        "vendor/sib",
      ]);
      await git(superSeed2, ["commit", "--no-gpg-sign", "-m", "add sib submodule"]);
      await git(superSeed2, ["push", "origin", "main"]);

      // Re-clone the workspace so it has both submodules.
      const ws = await cloneWorking(root, superRemote, "workspace-2");

      // Dirty BOTH submodules.
      await writeRepoFile(path.join(ws, "vendor/dep"), "fail.ts", "export const h = 8;\n");
      await writeRepoFile(path.join(ws, "vendor/sib"), "ok.ts", "export const i = 9;\n");

      // Break the first submodule's origin so its push fails.
      await git(path.join(ws, "vendor/dep"), [
        "remote",
        "set-url",
        "origin",
        path.join(root, "nope.git"),
      ]);

      const gitlinkDepBefore = await git(ws, ["rev-parse", "HEAD:vendor/dep"]);

      await service.createBranch({ workspacePath: ws, branchName: "boboddy/mixed" });
      const closure = buildCommitAndPushWorkBranch({
        gitCommitPushService: service,
        submoduleService,
        workspacePath: ws,
        workBranch: "boboddy/mixed",
        stepExecutionId: "step-exec-mixed",
      });
      // Must not throw despite the failed submodule push.
      let threw = false;
      try {
        await closure();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);

      // Failed submodule's gitlink is NOT recorded (excluded).
      const gitlinkDepAfter = await git(ws, ["rev-parse", "HEAD:vendor/dep"]);
      expect(gitlinkDepAfter).toBe(gitlinkDepBefore);

      // Successful sibling's gitlink IS recorded and matches its pushed tip.
      const sibLocal = await git(path.join(ws, "vendor/sib"), ["rev-parse", "boboddy/mixed"]);
      const sibRemote = await git(sib, ["rev-parse", "boboddy/mixed"]);
      expect(sibRemote).toBe(sibLocal);
      expect(await git(ws, ["rev-parse", "HEAD:vendor/sib"])).toBe(sibLocal);
    });

    test("no-submodule repo → behaves like the superproject-only flow (regression)", async () => {
      const plainRemote = await createBareRemoteWithSeed(root, "plain");
      const plain = await cloneWorking(root, plainRemote, "plain-ws");
      await writeRepoFile(plain, "only.ts", "export const j = 10;\n");

      await service.createBranch({ workspacePath: plain, branchName: "boboddy/plain" });
      const closure = buildCommitAndPushWorkBranch({
        gitCommitPushService: service,
        submoduleService,
        workspacePath: plain,
        workBranch: "boboddy/plain",
        stepExecutionId: "step-exec-plain",
      });
      await closure();

      expect(await git(plain, ["show", "--name-only", "--pretty=format:", "HEAD"]))
        .toContain("only.ts");
      const localTip = await git(plain, ["rev-parse", "boboddy/plain"]);
      const remoteTip = await git(plainRemote, ["rev-parse", "boboddy/plain"]);
      expect(remoteTip).toBe(localTip);
    });
  });
});

/** Clone WITHOUT recursing submodules → submodule dir stays empty/uninitialized. */
async function cloneWorkingNoRecurse(
  root: string,
  remote: string,
  name: string,
): Promise<string> {
  const workspace = path.join(root, name);
  await git(root, [
    "-c",
    "protocol.file.allow=always",
    "clone",
    remote,
    workspace,
  ]);
  await git(workspace, ["config", "user.email", "workspace@boboddy.dev"]);
  await git(workspace, ["config", "user.name", "Workspace"]);
  return workspace;
}
