import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import {
  buildFindingsSubmissionPath,
  writeCurrentExecutionInfoFile,
} from "../../../../src/work/task/application/process-project-work-findings";
import { monitorStartedClaimedTask } from "../../../../src/work/task/application/process-project-work-monitor";
import { buildTestZip } from "../../../support/build-test-zip";
import {
  createDeps,
  createInput,
  createStartedTask,
  createTracker,
  resultSchema,
  stopStub,
} from "./helpers/process-project-work-monitor-artifacts-fixtures";

describe("monitorStartedClaimedTask artifacts", () => {
  test.concurrent(
    "collects artifacts and flushes logs BEFORE completing the step (success)",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-artifact-order-"),
      );
      const startedTask = createStartedTask(workspacePath);
      const tracker = createTracker();
      const input = createInput(startedTask);

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
      const flush = vi.fn(() => {
        callOrder.push("flush");
        return Promise.resolve();
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
          if (statusCall === 1) {
            return { running: true };
          }
          if (statusCall === 2) {
            return { running: false };
          }
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

      await monitorStartedClaimedTask(
        input,
        deps,
        tracker,
        startedTask,
        stopStub(),
        { flush },
      );

      // Core regression guard: artifacts are collected and logs flushed while
      // the step is still "running", i.e. before completeTask.
      expect(callOrder).toEqual(["saveArtifact", "flush", "completeTask"]);
      // Idempotency: the artifact is collected exactly once.
      expect(saveArtifact).toHaveBeenCalledTimes(1);
      expect(saveArtifact).toHaveBeenCalledWith({
        taskId: startedTask.taskId,
        claimToken: startedTask.claimToken,
        sourcePath: path.join(stepArtifactsDir, "trace.zip"),
        relativeStorePath: "trace.zip",
        kind: "playwright-trace",
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).toHaveBeenCalledTimes(1);
    },
  );

  test.concurrent(
    "collects artifacts and flushes logs on the failure path, propagating the error",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-artifact-fail-"),
      );
      const startedTask = createStartedTask(workspacePath);
      const tracker = createTracker();
      const input = createInput(startedTask);

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
      const flush = vi.fn(() => {
        callOrder.push("flush");
        return Promise.resolve();
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
        // Never reached: findings validation throws before completion.
        finalStepStatus: "running",
        getSessionStatus: vi.fn(async () => {
          statusCall += 1;
          if (statusCall === 1) {
            return { running: true };
          }
          if (statusCall === 2) {
            return { running: false };
          }
          // The agent wrote an artifact AND a findings file, but the findings
          // do NOT match the result schema, so tryPersistAgentFindings throws
          // before onBeforeComplete runs — driving the catch-block failure path.
          await mkdir(stepArtifactsDir, { recursive: true });
          await writeFile(
            path.join(stepArtifactsDir, "trace.zip"),
            buildTestZip(["trace.trace", "trace.network"]),
          );
          await writeFile(
            buildFindingsSubmissionPath(workspacePath),
            `${JSON.stringify({ findingsJson: { unexpected: true } }, null, 2)}\n`,
            "utf8",
          );
          return { running: false };
        }),
      });

      // The findings validation failure must propagate unchanged (the failure
      // path's best-effort artifact collection must not swallow/replace it).
      let thrown: unknown;
      try {
        await monitorStartedClaimedTask(
          input,
          deps,
          tracker,
          startedTask,
          stopStub(),
          { flush },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(
        /findingsJson does not match resultSchemaJson/,
      );

      // Artifacts are still collected on the failure path...
      expect(saveArtifact).toHaveBeenCalledTimes(1);
      expect(saveArtifact).toHaveBeenCalledWith({
        taskId: startedTask.taskId,
        claimToken: startedTask.claimToken,
        sourcePath: path.join(stepArtifactsDir, "trace.zip"),
        relativeStorePath: "trace.zip",
        kind: "playwright-trace",
      });
      // ...and the log stream is flushed on the failure path too.
      expect(flush).toHaveBeenCalledTimes(1);
      // The failure path never completes the step.
      expect(completeTask).not.toHaveBeenCalled();
      // The step is marked failed, not succeeded.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markFailed).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "prunes local artifacts once after saving, and a prune() rejection doesn't fail the step or block completion",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-artifact-prune-"),
      );
      const startedTask = createStartedTask(workspacePath);
      const tracker = createTracker();
      const input = createInput(startedTask);

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
      const prune = vi.fn(() => {
        callOrder.push("prune");
        return Promise.reject(new Error("prune failed"));
      });
      const flush = vi.fn(() => {
        callOrder.push("flush");
        return Promise.resolve();
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
        prune,
        getSessionStatus: vi.fn(async () => {
          statusCall += 1;
          if (statusCall === 1) {
            return { running: true };
          }
          if (statusCall === 2) {
            return { running: false };
          }
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

      await monitorStartedClaimedTask(
        input,
        deps,
        tracker,
        startedTask,
        stopStub(),
        { flush },
      );

      // Runs exactly once, after the artifact save, and a rejection doesn't
      // stop completeTask from running afterward.
      expect(callOrder).toEqual([
        "saveArtifact",
        "prune",
        "flush",
        "completeTask",
      ]);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(completeTask).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markFailed).not.toHaveBeenCalled();
    },
  );
});
