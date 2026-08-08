/**
 * Fixture builders for git-cli-commit-push-submodule.test.ts, split out into
 * their own module purely to keep the test file under this repo's 400-line
 * limit. Each test in that file calls `setupFixture()` (and, for a couple of
 * cases, `cloneWorkingNoRecurse` directly) to get its own fully-local set of
 * temp git repos — nothing here is shared mutable state.
 */
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitCommitPushService } from "../../../../src/runtime/runtime-service/application/git-commit-push-service";
import type { SubmoduleService } from "../../../../src/runtime/runtime-service/application/submodule-service";
import { buildCommitAndPushWorkBranch } from "../../../../src/work/step-execution/infra/work-branch-manager";
import { git, writeRepoFile } from "./git-test-fixtures";

/** A bare remote seeded with one commit on `main` via a throwaway clone. */
export async function createBareRemoteWithSeed(
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
export async function cloneWorking(
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

/** Clone WITHOUT recursing submodules → submodule dir stays empty/uninitialized. */
export async function cloneWorkingNoRecurse(
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

/**
 * Builds one full fixture: a bare `sub` remote, a bare `super` remote whose
 * superproject already has `sub` added at `vendor/dep`, and a recursive clone
 * of `super` at `workspace`. Every test in git-cli-commit-push-submodule.test.ts
 * (including the ones in the nested "orchestration" describe) calls this
 * itself and cleans up its own `root`, so concurrently-running tests never
 * share mutable state.
 */
export async function setupFixture(): Promise<{
  root: string;
  superRemote: string;
  subRemote: string;
  workspace: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-submodule-commit-"));
  const subRemote = await createBareRemoteWithSeed(root, "sub");
  const superRemote = await createBareRemoteWithSeed(root, "super");

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

  const workspace = await cloneWorking(root, superRemote, "workspace");

  return { root, superRemote, subRemote, workspace };
}

/**
 * Adds an additional submodule (seeded via `createBareRemoteWithSeed`) to the
 * superproject at `vendor/<name>` via a throwaway clone, then pushes the
 * change to `superRemote`. Returns the new submodule's own bare remote path.
 */
export async function addSiblingSubmodule(
  root: string,
  superRemote: string,
  name: string,
): Promise<string> {
  const sib = await createBareRemoteWithSeed(root, name);
  const superSeed = path.join(root, `super-add-${name}`);
  await git(root, ["clone", superRemote, superSeed]);
  await git(superSeed, ["config", "user.email", `add-${name}@boboddy.dev`]);
  await git(superSeed, ["config", "user.name", `Add-${name}`]);
  await git(superSeed, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    sib,
    `vendor/${name}`,
  ]);
  await git(superSeed, [
    "commit",
    "--no-gpg-sign",
    "-m",
    `add ${name} submodule`,
  ]);
  await git(superSeed, ["push", "origin", "main"]);
  return sib;
}

/**
 * Runs the {@link buildCommitAndPushWorkBranch} orchestrator end-to-end
 * against `workspace`: creates the work branch, then invokes and awaits the
 * returned closure. Shared by the "orchestration" tests purely to avoid
 * repeating this boilerplate in each one.
 */
export async function runClosure(
  gitCommitPushService: GitCommitPushService,
  submoduleService: SubmoduleService,
  workspace: string,
  workBranch: string,
): Promise<void> {
  await gitCommitPushService.createBranch({
    workspacePath: workspace,
    branchName: workBranch,
  });
  const closure = buildCommitAndPushWorkBranch({
    gitCommitPushService,
    submoduleService,
    workspacePath: workspace,
    workBranch,
    stepExecutionId: "step-exec-1",
  });
  await closure();
}
