/**
 * What a `readWrite` step on a managed runtime may commit, against REAL temp
 * git repos. The managed config the worker writes into the clone and the
 * install's own artifacts (`node_modules`, generated lockfiles) must never
 * reach the pushed commit, including in a repo that has no `.gitignore` for
 * them, and anything the repo already tracks at those paths is restored rather
 * than overwritten and committed.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS } from "../../../../src/runtime/runtime-service/domain/managed-runtimes";
import { managedRuntimeConfigPath } from "../../../../src/runtime/runtime-service/infra/managed-runtime-config";
import { WORK_BRANCH_EXCLUDE_PATHS } from "../../../../src/work/step-execution/infra/work-branch-manager";
import { git, writeRepoFile } from "./git-test-fixtures";

const CONFIG_PATH = managedRuntimeConfigPath("bun1");
const MANAGED_EXCLUDES = [
  ...WORK_BRANCH_EXCLUDE_PATHS,
  CONFIG_PATH,
  ...MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS,
];

async function setupWorkspace(
  seed: Record<string, string> = {},
): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-managed-runtime-"));
  const workspace = path.join(root, "workspace");
  await git(root, ["init", "-b", "main", workspace]);
  await git(workspace, ["config", "user.email", "workspace@boboddy.dev"]);
  await git(workspace, ["config", "user.name", "Workspace"]);
  await writeRepoFile(workspace, "README.md", "hello\n");
  for (const [relativePath, content] of Object.entries(seed)) {
    await writeRepoFile(workspace, relativePath, content);
  }
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "--no-gpg-sign", "-m", "init"]);
  return { root, workspace };
}

async function committedFiles(workspace: string): Promise<string[]> {
  const out = await git(workspace, [
    "show",
    "--name-only",
    "--pretty=format:",
    "HEAD",
  ]);
  return out.split("\n").filter((line) => line.length > 0);
}

describe("commitAll on a managed runtime", () => {
  const service = new GitCliCommitPushService();

  test.concurrent(
    "a repo with no .gitignore does not commit the managed config, node_modules or generated lockfiles",
    async () => {
      const { root, workspace } = await setupWorkspace();
      try {
        await writeRepoFile(workspace, CONFIG_PATH, "{}\n");
        await writeRepoFile(
          workspace,
          ".boboddy/pipeline-builder/node_modules/@boboddy/sdk/index.js",
          "module.exports = {};\n",
        );
        await writeRepoFile(
          workspace,
          ".boboddy/pipeline-builder/bun.lock",
          "{}\n",
        );
        await writeRepoFile(
          workspace,
          ".boboddy/pipeline-builder/package-lock.json",
          "{}\n",
        );
        await writeRepoFile(workspace, "result.txt", "the step output\n");

        const result = await service.commitAll({
          workspacePath: workspace,
          message: "boboddy: managed step",
          excludePaths: MANAGED_EXCLUDES,
        });

        expect(result.committed).toBe(true);
        expect(await committedFiles(workspace)).toEqual(["result.txt"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "the control: without the managed excludes the install artifacts are committed",
    async () => {
      const { root, workspace } = await setupWorkspace();
      try {
        await writeRepoFile(
          workspace,
          ".boboddy/pipeline-builder/node_modules/zod/index.js",
          "module.exports = {};\n",
        );
        await writeRepoFile(
          workspace,
          ".boboddy/pipeline-builder/bun.lock",
          "{}\n",
        );

        await service.commitAll({
          workspacePath: workspace,
          message: "boboddy: control",
          excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
        });

        expect(await committedFiles(workspace)).toEqual([
          ".boboddy/pipeline-builder/bun.lock",
          ".boboddy/pipeline-builder/node_modules/zod/index.js",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "the managed directory is excluded even when the exact config path is not passed",
    async () => {
      const { root, workspace } = await setupWorkspace();
      try {
        await writeRepoFile(workspace, CONFIG_PATH, "{}\n");
        await writeRepoFile(workspace, "result.txt", "output\n");

        await service.commitAll({
          workspacePath: workspace,
          message: "boboddy: dir exclude",
          excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
        });

        expect(await committedFiles(workspace)).toEqual(["result.txt"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a repo that already tracks a file at the managed config path gets it restored, not overwritten and committed",
    async () => {
      const { root, workspace } = await setupWorkspace({
        [CONFIG_PATH]: "the user's own file\n",
      });
      try {
        await git(workspace, ["checkout", "-b", "boboddy/step"]);
        await writeRepoFile(
          workspace,
          CONFIG_PATH,
          "synthesized by the worker\n",
        );
        await writeRepoFile(workspace, "result.txt", "output\n");

        await service.commitAll({
          workspacePath: workspace,
          message: "boboddy: collision",
          excludePaths: MANAGED_EXCLUDES,
        });

        expect(await committedFiles(workspace)).toEqual(["result.txt"]);
        expect(await readFile(path.join(workspace, CONFIG_PATH), "utf8")).toBe(
          "the user's own file\n",
        );
        expect(await git(workspace, ["status", "--porcelain"])).toBe("");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a lockfile the author committed is restored when the install rewrote it, never lost",
    async () => {
      const { root, workspace } = await setupWorkspace({
        ".boboddy/pipeline-builder/bun.lock": "the author's lockfile\n",
      });
      try {
        await git(workspace, ["checkout", "-b", "boboddy/step"]);
        await writeRepoFile(
          workspace,
          ".boboddy/pipeline-builder/bun.lock",
          "rewritten by install\n",
        );
        await writeRepoFile(workspace, "result.txt", "output\n");

        await service.commitAll({
          workspacePath: workspace,
          message: "boboddy: tracked lockfile",
          excludePaths: MANAGED_EXCLUDES,
        });

        expect(await committedFiles(workspace)).toEqual(["result.txt"]);
        expect(
          await readFile(
            path.join(workspace, ".boboddy/pipeline-builder/bun.lock"),
            "utf8",
          ),
        ).toBe("the author's lockfile\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a step that only produced install artifacts commits nothing",
    async () => {
      const { root, workspace } = await setupWorkspace();
      try {
        await writeRepoFile(workspace, CONFIG_PATH, "{}\n");
        await writeRepoFile(
          workspace,
          ".boboddy/pipeline-builder/node_modules/zod/index.js",
          "module.exports = {};\n",
        );

        const result = await service.commitAll({
          workspacePath: workspace,
          message: "boboddy: nothing",
          excludePaths: MANAGED_EXCLUDES,
        });

        expect(result.committed).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
