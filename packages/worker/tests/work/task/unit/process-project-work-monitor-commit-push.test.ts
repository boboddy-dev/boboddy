/**
 * The monitor's hand-off to `commitAndPushWorkBranch`: the validated findings
 * reach it as `result`, and a thrown push error (`onPushFailure: "fail"`) fails
 * the step instead of completing it, while artifacts are still collected.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import type { AnyJsonValue } from "../../../../src/common/contracts/json";
import {
  buildFindingsSubmissionPath,
  writeCurrentExecutionInfoFile,
} from "../../../../src/work/task/application/process-project-work-findings";
import { monitorStartedClaimedTask } from "../../../../src/work/task/application/process-project-work-monitor";
import type { CommitAndPushWorkBranchResult } from "../../../../src/work/task/contracts/process-project-work-types";
import { buildTestZip } from "../../../support/build-test-zip";
import { captureRejection } from "../../../support/capture-rejection";
import {
  createDeps,
  createInput,
  createStartedTask,
  createTracker,
  resultSchema,
  stopStub,
} from "./helpers/process-project-work-monitor-artifacts-fixtures";

type CommitAndPushWorkBranch = (ctx: {
  result: AnyJsonValue;
}) => Promise<CommitAndPushWorkBranchResult>;

async function setup(commitAndPushWorkBranch: CommitAndPushWorkBranch) {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "boboddy-monitor-commit-push-"),
  );
  const base = createStartedTask(workspacePath);
  const startedTask = {
    ...base,
    environment: {
      ...base.environment,
      workBranch: "boboddy/step-abc",
      createdFromBranch: "main",
      commitAndPushWorkBranch,
    },
  };
  await writeCurrentExecutionInfoFile(workspacePath, {
    taskId: startedTask.taskId,
    resultSchemaJson: resultSchema,
  });
  const stepArtifactsDir = path.join(
    workspacePath,
    ".boboddy",
    "step-artifacts",
  );

  const callOrder: string[] = [];
  const saveArtifact = vi.fn(() => {
    callOrder.push("saveArtifact");
    return Promise.resolve({ storeRef: "store-ref", sizeBytes: 1 });
  });
  const completeTask = vi.fn(() => {
    callOrder.push("completeTask");
    return Promise.resolve(undefined);
  });
  let statusCall = 0;
  const deps = createDeps({
    callOrder,
    saveArtifact,
    completeTask,
    finalStepStatus: "succeeded",
    getSessionStatus: vi.fn(async () => {
      statusCall += 1;
      if (statusCall === 1) return { running: true };
      if (statusCall === 2) return { running: false };
      await mkdir(stepArtifactsDir, { recursive: true });
      await writeFile(
        path.join(stepArtifactsDir, "trace.zip"),
        buildTestZip(["trace.trace", "trace.network"]),
      );
      await writeFile(
        buildFindingsSubmissionPath(workspacePath),
        `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
        "utf8",
      );
      return { running: false };
    }),
  });
  const tracker = createTracker();
  const run = () =>
    monitorStartedClaimedTask(
      createInput(startedTask),
      deps,
      tracker,
      startedTask,
      stopStub(),
      { flush: vi.fn(() => Promise.resolve()) },
    );
  return { run, tracker, callOrder, saveArtifact, completeTask };
}

describe("monitorStartedClaimedTask commit and push", () => {
  test.concurrent(
    "hands the validated findings to commitAndPushWorkBranch as result, before completing",
    async () => {
      const commitAndPushWorkBranch = vi.fn<CommitAndPushWorkBranch>(() =>
        Promise.resolve({ pushed: true }),
      );
      const { run, callOrder, completeTask } = await setup(
        commitAndPushWorkBranch,
      );

      await run();

      expect(commitAndPushWorkBranch).toHaveBeenCalledTimes(1);
      expect(commitAndPushWorkBranch).toHaveBeenCalledWith({
        result: { summary: "done" },
      });
      expect(callOrder).toEqual(["saveArtifact", "completeTask"]);
      expect(completeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          resultJson: { summary: "done" },
          workBranch: "boboddy/step-abc",
        }),
      );
    },
  );

  test.concurrent(
    "a failed push under onPushFailure warn completes the step with a null workBranch",
    async () => {
      const commitAndPushWorkBranch = vi.fn<CommitAndPushWorkBranch>(() =>
        Promise.resolve({ pushed: false }),
      );
      const { run, callOrder, completeTask } = await setup(
        commitAndPushWorkBranch,
      );

      await run();

      expect(callOrder).toEqual(["saveArtifact", "completeTask"]);
      expect(completeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          resultJson: { summary: "done" },
          workBranch: null,
          createdFromBranch: "main",
        }),
      );
    },
  );

  test.concurrent(
    "a thrown push error fails the step, never completes it, and still collects artifacts",
    async () => {
      const commitAndPushWorkBranch = vi.fn<CommitAndPushWorkBranch>(() =>
        Promise.reject(
          new Error(
            'Failed to push work branch "boboddy/step-abc": remote rejected',
          ),
        ),
      );
      const { run, tracker, saveArtifact, completeTask } = await setup(
        commitAndPushWorkBranch,
      );

      const failure = await captureRejection(run());

      expect(failure.message).toContain(
        'Failed to push work branch "boboddy/step-abc"',
      );

      expect(completeTask).not.toHaveBeenCalled();
      expect(saveArtifact).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          failureReason: expect.stringContaining(
            'Failed to push work branch "boboddy/step-abc"',
          ) as string,
        }),
      );
    },
  );
});
