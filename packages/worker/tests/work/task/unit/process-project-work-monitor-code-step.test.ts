import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import {
  buildFindingsSubmissionPath,
  writeCurrentExecutionInfoFile,
} from "../../../../src/work/task/application/process-project-work-findings";
import { monitorStartedClaimedTask } from "../../../../src/work/task/application/process-project-work-monitor";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StartedClaimedTask,
  TaskRunTracker,
} from "../../../../src/work/task/contracts/process-project-work-types";

function createCodeTask(workspacePath: string): StartedClaimedTask {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    taskId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003"),
    claimToken: "claim-token",
    agentSessionId: null,
    environment: {
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agent: null,
      aiImage: "opencode-runtime@0.0.0-test",
      networkName: "",
      secretValues: [],
      cleanup: vi.fn(() => Promise.resolve()),
    },
  };
}

function createTracker(): TaskRunTracker {
  return {
    createSession: vi.fn(),
    markRunning: vi.fn(),
    attachAgentSession: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  };
}

function createInput(startedTask: StartedClaimedTask): ProcessProjectWorkInput {
  return {
    projectId: startedTask.projectId,
    batchSize: 1,
    concurrency: 1,
    pollIntervalMs: 0,
    leaseDurationSeconds: 30,
    workerId: "worker-1",
    preserveRuntimeOnComplete: true,
    once: true,
  };
}

function createDeps(
  stepStatus: "running" | "succeeded",
  overrides: { saveArtifact?: ReturnType<typeof vi.fn> } = {},
): ProcessProjectWorkDeps {
  return {
    workerClient: {
      userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
      claimTasks: vi.fn(),
      heartbeatTask: vi.fn(),
      failTask: vi.fn(() => Promise.resolve(undefined)),
      completeTask: vi.fn(() => Promise.resolve(undefined)),
      getTask: vi.fn(() => Promise.resolve({ status: stepStatus })),
      getTaskWorkerContext: vi.fn(),
      createArtifactUploadUrl: vi.fn(),
      recordArtifact: vi.fn(),
      recordArtifactFailure: vi.fn(),
      appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    },
    createRunTracker: vi.fn(),
    runtimeEnvironmentOrchestrator: { launch: vi.fn() },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
      sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
    },
    artifactStore: {
      saveArtifact: overrides.saveArtifact ?? vi.fn(),
    },
    sleep: vi.fn(() => Promise.resolve(undefined)),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
  };
}

const stopStub = () => ({ stop: vi.fn(() => Promise.resolve()) });
const flushStub = () => ({ flush: vi.fn(() => Promise.resolve()) });

describe("monitorStartedClaimedTask for a code step", () => {
  test("completes from the findings file without polling an agent session", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-monitor-code-step-"),
    );
    const startedTask = createCodeTask(workspacePath);
    const tracker = createTracker();
    await writeCurrentExecutionInfoFile(workspacePath, {
      taskId: startedTask.taskId,
      resultSchemaJson: {
        type: "object",
        required: ["summary"],
        additionalProperties: false,
        properties: { summary: { type: "string" } },
      },
    });
    await writeFile(
      buildFindingsSubmissionPath(workspacePath),
      `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
      "utf8",
    );
    const deps = createDeps("succeeded");

    await monitorStartedClaimedTask(
      createInput(startedTask),
      deps,
      tracker,
      startedTask,
      stopStub(),
      flushStub(),
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.workerClient.completeTask).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.getSessionStatus).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.sendRetryPrompt).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.markSucceeded).toHaveBeenCalledWith({
      id: startedTask.localRuntimeSessionId,
      metadataJson: JSON.stringify({ agentSessionId: null }),
    });
  });

  test("fails fast with a code-step error when the findings file is missing", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-monitor-code-step-missing-"),
    );
    const startedTask = createCodeTask(workspacePath);
    const tracker = createTracker();
    const deps = createDeps("running");

    let caught: unknown;
    try {
      await monitorStartedClaimedTask(
        createInput(startedTask),
        deps,
        tracker,
        startedTask,
        stopStub(),
        flushStub(),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      `Code step finished without writing its findings file (${buildFindingsSubmissionPath(workspacePath)})`,
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.getSessionStatus).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.sendRetryPrompt).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.sleep).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.markFailed).toHaveBeenCalledWith({
      id: startedTask.localRuntimeSessionId,
      failureReason: (caught as Error).message,
      metadataJson: JSON.stringify({
        agentSessionId: null,
        finalStepStatus: "failed",
      }),
    });
  });

  test("rejects an execution with an agent runtime but no session id", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-monitor-code-step-invariant-"),
    );
    const base = createCodeTask(workspacePath);
    const startedTask: StartedClaimedTask = {
      ...base,
      environment: {
        ...base.environment,
        agent: {
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
          version: "0.0.0-test",
          logDirectory: "/logs",
        },
      },
    };
    const deps = createDeps("running");

    let caught: unknown;
    try {
      await monitorStartedClaimedTask(
        createInput(startedTask),
        deps,
        createTracker(),
        startedTask,
        stopStub(),
        flushStub(),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/together, or neither/u);
  });
});
