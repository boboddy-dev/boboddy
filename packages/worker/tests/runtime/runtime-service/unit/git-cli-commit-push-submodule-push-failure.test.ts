/**
 * A failed submodule push under `onPushFailure: "fail"` (the default), against
 * REAL temp git repos. The `"warn"` counterpart, including the gitlink
 * exclusion, lives in git-cli-commit-push-submodule.test.ts.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { GitCliSubmoduleService } from "../../../../src/runtime/runtime-service/infra/git-cli-submodule-service";
import {
  buildCommitAndPushWorkBranch,
  WorkBranchPushError,
} from "../../../../src/work/step-execution/infra/work-branch-manager";
import { captureRejection } from "../../../support/capture-rejection";
import { git, writeRepoFile } from "./git-test-fixtures";
import {
  addSiblingSubmodule,
  cloneWorking,
  setupFixture,
} from "./git-submodule-commit-fixtures";

const TEST_TIMEOUT_MS = 20_000;

describe("buildCommitAndPushWorkBranch submodule push failure", () => {
  const service = new GitCliCommitPushService();
  const submoduleService = new GitCliSubmoduleService();

  async function setupBrokenSubmodule() {
    const { root, superRemote } = await setupFixture();
    await addSiblingSubmodule(root, superRemote, "sib");
    const workspace = await cloneWorking(root, superRemote, "workspace-2");
    await writeRepoFile(
      path.join(workspace, "vendor/dep"),
      "fail.ts",
      "export const h = 8;\n",
    );
    await git(path.join(workspace, "vendor/dep"), [
      "remote",
      "set-url",
      "origin",
      path.join(root, "nope.git"),
    ]);
    await service.createBranch({
      workspacePath: workspace,
      branchName: "boboddy/broken",
    });
    return { root, workspace };
  }

  test.concurrent(
    "default policy: throws a WorkBranchPushError naming the branch and submodule, and commits nothing in the superproject",
    async () => {
      const { root, workspace } = await setupBrokenSubmodule();
      try {
        const headBefore = await git(workspace, ["rev-parse", "HEAD"]);
        const closure = buildCommitAndPushWorkBranch({
          gitCommitPushService: service,
          submoduleService,
          workspacePath: workspace,
          workBranch: "boboddy/broken",
          stepExecutionId: "step-exec-broken",
        });

        const failure = await captureRejection(closure({ result: {} }));

        expect(failure).toBeInstanceOf(WorkBranchPushError);
        expect(failure.message).toContain("boboddy/broken");
        expect(failure.message).toContain("vendor/dep");
        expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(headBefore);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    'explicit "fail": throws as well',
    async () => {
      const { root, workspace } = await setupBrokenSubmodule();
      try {
        const closure = buildCommitAndPushWorkBranch({
          gitCommitPushService: service,
          submoduleService,
          workspacePath: workspace,
          workBranch: "boboddy/broken",
          stepExecutionId: "step-exec-broken",
          onPushFailure: "fail",
        });

        const failure = await captureRejection(closure({ result: {} }));

        expect(failure).toBeInstanceOf(WorkBranchPushError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
