import { mkdtemp, writeFile } from "node:fs/promises";
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

function createCodeStepExecution(
  workspacePath: string,
): StartedClaimedExecution {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    stepExecutionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003"),
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

function createDeps(
  stepStatus: "running" | "succeeded",
  overrides: { saveArtifact?: ReturnType<typeof vi.fn> } = {},
): ProcessProjectWorkDeps {
  return {
    workerClient: {
      userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
      claimStepExecutions: vi.fn(),
      heartbeatStepExecution: vi.fn(),
      failStepExecution: vi.fn(() => Promise.resolve(undefined)),
      completeStepExecution: vi.fn(() => Promise.resolve(undefined)),
      getStepExecution: vi.fn(() => Promise.resolve({ status: stepStatus })),
      getStepExecutionWorkerContext: vi.fn(),
      createArtifactUploadUrl: vi.fn(),
      recordArtifact: vi.fn(),
      recordArtifactFailure: vi.fn(),
      appendStepExecutionLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
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

describe("monitorStartedClaimedExecution for a code step", () => {
  test("completes from the findings file without polling an agent session", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-monitor-code-step-"),
    );
    const startedExecution = createCodeStepExecution(workspacePath);
    const tracker = createTracker();
    await writeCurrentExecutionInfoFile(workspacePath, {
      stepExecutionId: startedExecution.stepExecutionId,
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

    await monitorStartedClaimedExecution(
      createInput(startedExecution),
      deps,
      tracker,
      startedExecution,
      stopStub(),
      flushStub(),
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.workerClient.completeStepExecution).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.getSessionStatus).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.sendRetryPrompt).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.markSucceeded).toHaveBeenCalledWith({
      id: startedExecution.localRuntimeSessionId,
      metadataJson: JSON.stringify({ agentSessionId: null }),
    });
  });

  test("fails fast with a code-step error when the findings file is missing", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-monitor-code-step-missing-"),
    );
    const startedExecution = createCodeStepExecution(workspacePath);
    const tracker = createTracker();
    const deps = createDeps("running");

    let caught: unknown;
    try {
      await monitorStartedClaimedExecution(
        createInput(startedExecution),
        deps,
        tracker,
        startedExecution,
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
      id: startedExecution.localRuntimeSessionId,
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
    const base = createCodeStepExecution(workspacePath);
    const startedExecution: StartedClaimedExecution = {
      ...base,
      environment: {
        ...base.environment,
        agent: { baseUrl: "http://127.0.0.1:4096", logDirectory: "/logs" },
      },
    };
    const deps = createDeps("running");

    let caught: unknown;
    try {
      await monitorStartedClaimedExecution(
        createInput(startedExecution),
        deps,
        createTracker(),
        startedExecution,
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
