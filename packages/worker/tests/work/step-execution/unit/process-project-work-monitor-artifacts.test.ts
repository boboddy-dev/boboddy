import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import {
  buildFindingsSubmissionPath,
  writeCurrentExecutionInfoFile,
} from "../../../../src/work/step-execution/application/process-project-work-findings";
import { monitorStartedClaimedExecution } from "../../../../src/work/step-execution/application/process-project-work-monitor";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StartedClaimedExecution,
  StepExecutionRunTracker,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";
import { buildTestZip } from "../../../support/build-test-zip";

function createStartedExecution(workspacePath: string): StartedClaimedExecution {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    stepExecutionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003"),
    claimToken: "claim-token",
    agentSessionId: "agent-session-id",
    environment: {
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      opencodeLogDirectory: path.join(workspacePath, ".logs"),
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agentBaseUrl: "http://127.0.0.1:4096",
      aiImage: "opencode-runtime@0.0.0-test",
      networkName: "",
      secretValues: [],
      cleanup: vi.fn(() => Promise.resolve()),
    },
  };
}

function createTracker(): StepExecutionRunTracker {
  return {
    createSession: vi.fn(),
    markRunning: vi.fn(),
    attachAgentSession: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  };
}

function createInput(
  startedExecution: StartedClaimedExecution,
): ProcessProjectWorkInput {
  return {
    projectId: startedExecution.projectId,
    batchSize: 1,
    concurrency: 1,
    pollIntervalMs: 0,
    leaseDurationSeconds: 30,
    workerId: "worker-1",
    preserveRuntimeOnComplete: true,
    once: true,
  };
}

const stopStub = () => ({ stop: vi.fn(() => Promise.resolve()) });

const resultSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string" } },
} as const;

/**
 * Builds a `deps` matching the existing monitor unit test, but wires the
 * provided call-order recorders/spies into `saveArtifact`, `completeStepExecution`,
 * and `getSessionStatus` so ordering and idempotency can be asserted.
 */
function createDeps(config: {
  callOrder: string[];
  saveArtifact: ReturnType<typeof vi.fn>;
  completeStepExecution: ReturnType<typeof vi.fn>;
  finalStepStatus: "succeeded" | "running";
  getSessionStatus: ProcessProjectWorkDeps["agentRunner"]["getSessionStatus"];
}): ProcessProjectWorkDeps {
  return {
    workerClient: {
      userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
      claimStepExecutions: vi.fn(),
      heartbeatStepExecution: vi.fn(),
      failStepExecution: vi.fn(() => Promise.resolve(undefined)),
      completeStepExecution: config.completeStepExecution,
      getStepExecution: vi.fn(() =>
        Promise.resolve({ status: config.finalStepStatus }),
      ),
      getStepExecutionWorkerContext: vi.fn(),
      createArtifactUploadUrl: vi.fn(),
      recordArtifact: vi.fn(),
      appendStepExecutionLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    },
    createRunTracker: vi.fn(),
    runtimeEnvironmentOrchestrator: { launch: vi.fn() },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: config.getSessionStatus,
      sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
    },
    artifactStore: { saveArtifact: config.saveArtifact },
    sleep: vi.fn(() => Promise.resolve(undefined)),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
  };
}

describe("monitorStartedClaimedExecution artifacts", () => {
  test.concurrent(
    "collects artifacts and flushes logs BEFORE completing the step (success)",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-artifact-order-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
      const tracker = createTracker();
      const input = createInput(startedExecution);

      await writeCurrentExecutionInfoFile(workspacePath, {
        stepExecutionId: startedExecution.stepExecutionId,
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
      const completeStepExecution = vi.fn(() => {
        callOrder.push("completeStepExecution");
        return Promise.resolve(undefined);
      });

      let statusCall = 0;
      const deps = createDeps({
        callOrder,
        saveArtifact,
        completeStepExecution,
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

      await monitorStartedClaimedExecution(
        input,
        deps,
        tracker,
        startedExecution,
        stopStub(),
        { flush },
      );

      // Core regression guard: artifacts are collected and logs flushed while
      // the step is still "running", i.e. before completeStepExecution.
      expect(callOrder).toEqual(["saveArtifact", "flush", "completeStepExecution"]);
      // Idempotency: the artifact is collected exactly once.
      expect(saveArtifact).toHaveBeenCalledTimes(1);
      expect(saveArtifact).toHaveBeenCalledWith({
        stepExecutionId: startedExecution.stepExecutionId,
        claimToken: startedExecution.claimToken,
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
      const startedExecution = createStartedExecution(workspacePath);
      const tracker = createTracker();
      const input = createInput(startedExecution);

      await writeCurrentExecutionInfoFile(workspacePath, {
        stepExecutionId: startedExecution.stepExecutionId,
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
      const completeStepExecution = vi.fn(() => {
        callOrder.push("completeStepExecution");
        return Promise.resolve(undefined);
      });

      let statusCall = 0;
      const deps = createDeps({
        callOrder,
        saveArtifact,
        completeStepExecution,
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
        await monitorStartedClaimedExecution(
          input,
          deps,
          tracker,
          startedExecution,
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
        stepExecutionId: startedExecution.stepExecutionId,
        claimToken: startedExecution.claimToken,
        sourcePath: path.join(stepArtifactsDir, "trace.zip"),
        relativeStorePath: "trace.zip",
        kind: "playwright-trace",
      });
      // ...and the log stream is flushed on the failure path too.
      expect(flush).toHaveBeenCalledTimes(1);
      // The failure path never completes the step.
      expect(completeStepExecution).not.toHaveBeenCalled();
      // The step is marked failed, not succeeded.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markFailed).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).not.toHaveBeenCalled();
    },
  );
});
