/**
 * Submodule commit/branch/push behavior for {@link GitCliCommitPushService} and
 * the {@link buildCommitAndPushWorkBranch} orchestrator, against REAL temp git
 * repos. A bare remote is created per submodule so pushes work without network.
 * Local-path submodule add/clone requires `protocol.file.allow=always` on modern
 * git, so setup passes it per-invocation. Mirrors the real-temp-repo style of
 * git-cli-commit-push-service.test.ts and git-cli-submodule-service.test.ts.
 *
 * Each test builds and tears down its own fixture inline (via the shared
 * `setupFixture` from ./git-submodule-commit-fixtures) so tests share no
 * mutable state and can run under `test.concurrent`. A generous per-test
 * timeout is set because running many real-git fixtures concurrently causes
 * CPU/IO contention that the default 5s budget doesn't always cover.
 */
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { GitCliSubmoduleService } from "../../../../src/runtime/runtime-service/infra/git-cli-submodule-service";
import { buildCommitAndPushWorkBranch } from "../../../../src/work/step-execution/infra/work-branch-manager";
import { git, writeRepoFile } from "./git-test-fixtures";
import {
  addSiblingSubmodule,
  cloneWorking,
  cloneWorkingNoRecurse,
  createBareRemoteWithSeed,
  runClosure,
  setupFixture,
} from "./git-submodule-commit-fixtures";

const TEST_TIMEOUT_MS = 20_000;

describe("GitCliCommitPushService submodule methods", () => {
  const service = new GitCliCommitPushService();
  const submoduleService = new GitCliSubmoduleService();

  test.concurrent(
    "submoduleHasChanges: true when the submodule tree is dirty",
    async () => {
      const { root, workspace } = await setupFixture();
      try {
        const sub = path.join(workspace, "vendor/dep");
        await writeRepoFile(sub, "changed.ts", "export const a = 1;\n");
        expect(
          await service.submoduleHasChanges({
            workspacePath: workspace,
            submodulePath: "vendor/dep",
          }),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "submoduleHasChanges: false when the submodule tree is clean",
    async () => {
      const { root, workspace } = await setupFixture();
      try {
        expect(
          await service.submoduleHasChanges({
            workspacePath: workspace,
            submodulePath: "vendor/dep",
          }),
        ).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "submoduleHasChanges: false for an uninitialized submodule (no .git)",
    async () => {
      const { root, superRemote } = await setupFixture();
      try {
        // Fresh clone WITHOUT recursing leaves vendor/dep uninitialized (empty, no .git).
        const bare = await cloneWorkingNoRecurse(root, superRemote, "bare");
        expect(
          await service.submoduleHasChanges({
            workspacePath: bare,
            submodulePath: "vendor/dep",
          }),
        ).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "commitInSubmodule creates the branch and commits inside the submodule",
    async () => {
      const { root, workspace } = await setupFixture();
      try {
        const sub = path.join(workspace, "vendor/dep");
        await writeRepoFile(sub, "feature.ts", "export const b = 2;\n");

        const result = await service.commitInSubmodule({
          workspacePath: workspace,
          submodulePath: "vendor/dep",
          branchName: "boboddy/step-x",
          message: "boboddy: step x",
        });
        expect(result).toEqual({ committed: true, branchCreated: true });
        expect(await git(sub, ["branch", "--show-current"])).toBe(
          "boboddy/step-x",
        );
        expect(
          await git(sub, ["show", "--name-only", "--pretty=format:", "HEAD"]),
        ).toContain("feature.ts");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "pushSubmodule publishes the branch to the submodule's own origin",
    async () => {
      const { root, subRemote, workspace } = await setupFixture();
      try {
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
        const remoteTip = await git(subRemote, [
          "rev-parse",
          "boboddy/step-push",
        ]);
        expect(remoteTip).toBe(localTip);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.concurrent(
    "pushSubmodule throws on failure (nonexistent origin) — orchestrator handles it",
    async () => {
      const { root, workspace } = await setupFixture();
      try {
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
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  describe("buildCommitAndPushWorkBranch orchestration", () => {
    test.concurrent(
      "submodule WITH changes → branch/commit/push + superproject records gitlink",
      async () => {
        const { root, subRemote, workspace } = await setupFixture();
        try {
          const sub = path.join(workspace, "vendor/dep");
          await writeRepoFile(sub, "agent.ts", "export const e = 5;\n");

          const gitlinkBefore = await git(workspace, [
            "rev-parse",
            "HEAD:vendor/dep",
          ]);
          await runClosure(
            service,
            submoduleService,
            workspace,
            "boboddy/with-changes",
          );

          // Submodule branch created + pushed.
          expect(
            await git(sub, ["branch", "--list", "boboddy/with-changes"]),
          ).toContain("boboddy/with-changes");
          const subLocal = await git(sub, [
            "rev-parse",
            "boboddy/with-changes",
          ]);
          const subRemoteTip = await git(subRemote, [
            "rev-parse",
            "boboddy/with-changes",
          ]);
          expect(subRemoteTip).toBe(subLocal);

          // Superproject work-branch commit records the updated gitlink.
          const gitlinkAfter = await git(workspace, [
            "rev-parse",
            "HEAD:vendor/dep",
          ]);
          expect(gitlinkAfter).not.toBe(gitlinkBefore);
          expect(gitlinkAfter).toBe(subLocal);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test.concurrent(
      "submodule with NO changes → no branch, gitlink unchanged",
      async () => {
        const { root, workspace } = await setupFixture();
        try {
          // Only a superproject-level change; submodule tree stays clean.
          await writeRepoFile(workspace, "top.ts", "export const f = 6;\n");
          const sub = path.join(workspace, "vendor/dep");
          const gitlinkBefore = await git(workspace, [
            "rev-parse",
            "HEAD:vendor/dep",
          ]);

          await runClosure(
            service,
            submoduleService,
            workspace,
            "boboddy/no-changes",
          );

          expect(
            await git(sub, ["branch", "--list", "boboddy/no-changes"]),
          ).toBe("");
          const gitlinkAfter = await git(workspace, [
            "rev-parse",
            "HEAD:vendor/dep",
          ]);
          expect(gitlinkAfter).toBe(gitlinkBefore);
          // The superproject change was still committed.
          expect(
            await git(workspace, [
              "show",
              "--name-only",
              "--pretty=format:",
              "HEAD",
            ]),
          ).toContain("top.ts");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test.concurrent(
      "uninitialized submodule → skipped, no branch, no error",
      async () => {
        const { root, superRemote } = await setupFixture();
        try {
          const bare = await cloneWorkingNoRecurse(
            root,
            superRemote,
            "bare-orch",
          );
          await writeRepoFile(bare, "top.ts", "export const g = 7;\n");

          await service.createBranch({
            workspacePath: bare,
            branchName: "boboddy/uninit",
          });
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
          expect(
            await git(bare, [
              "show",
              "--name-only",
              "--pretty=format:",
              "HEAD",
            ]),
          ).toContain("top.ts");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test.concurrent(
      "submodule push FAILURE → step succeeds, failed gitlink excluded, sibling recorded",
      async () => {
        const { root, superRemote } = await setupFixture();
        try {
          // Add a SECOND submodule that will push successfully.
          const sib = await addSiblingSubmodule(root, superRemote, "sib");

          // Re-clone the workspace so it has both submodules.
          const ws = await cloneWorking(root, superRemote, "workspace-2");

          // Dirty BOTH submodules.
          await writeRepoFile(
            path.join(ws, "vendor/dep"),
            "fail.ts",
            "export const h = 8;\n",
          );
          await writeRepoFile(
            path.join(ws, "vendor/sib"),
            "ok.ts",
            "export const i = 9;\n",
          );

          // Break the first submodule's origin so its push fails.
          await git(path.join(ws, "vendor/dep"), [
            "remote",
            "set-url",
            "origin",
            path.join(root, "nope.git"),
          ]);

          const gitlinkDepBefore = await git(ws, [
            "rev-parse",
            "HEAD:vendor/dep",
          ]);

          await service.createBranch({
            workspacePath: ws,
            branchName: "boboddy/mixed",
          });
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
          const gitlinkDepAfter = await git(ws, [
            "rev-parse",
            "HEAD:vendor/dep",
          ]);
          expect(gitlinkDepAfter).toBe(gitlinkDepBefore);

          // Successful sibling's gitlink IS recorded and matches its pushed tip.
          const sibLocal = await git(path.join(ws, "vendor/sib"), [
            "rev-parse",
            "boboddy/mixed",
          ]);
          const sibRemote = await git(sib, ["rev-parse", "boboddy/mixed"]);
          expect(sibRemote).toBe(sibLocal);
          expect(await git(ws, ["rev-parse", "HEAD:vendor/sib"])).toBe(
            sibLocal,
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test.concurrent(
      "no-submodule repo → behaves like the superproject-only flow (regression)",
      async () => {
        const { root } = await setupFixture();
        try {
          const plainRemote = await createBareRemoteWithSeed(root, "plain");
          const plain = await cloneWorking(root, plainRemote, "plain-ws");
          await writeRepoFile(plain, "only.ts", "export const j = 10;\n");

          await service.createBranch({
            workspacePath: plain,
            branchName: "boboddy/plain",
          });
          const closure = buildCommitAndPushWorkBranch({
            gitCommitPushService: service,
            submoduleService,
            workspacePath: plain,
            workBranch: "boboddy/plain",
            stepExecutionId: "step-exec-plain",
          });
          await closure();

          expect(
            await git(plain, [
              "show",
              "--name-only",
              "--pretty=format:",
              "HEAD",
            ]),
          ).toContain("only.ts");
          const localTip = await git(plain, ["rev-parse", "boboddy/plain"]);
          const remoteTip = await git(plainRemote, [
            "rev-parse",
            "boboddy/plain",
          ]);
          expect(remoteTip).toBe(localTip);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  });
});
