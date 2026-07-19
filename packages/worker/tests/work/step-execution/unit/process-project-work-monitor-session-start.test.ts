import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { monitorStartedClaimedExecution } from "../../../../src/work/step-execution/application/process-project-work-monitor";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StartedClaimedExecution,
  StepExecutionRunTracker,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";

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

async function expectRejects(
  action: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(pattern);
}

describe("monitorStartedClaimedExecution session-start fail-fast", () => {
  test("fails fast when the agent session never starts within the timeout", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-monitor-never-start-"),
    );
    const startedExecution = createStartedExecution(workspacePath);
    const tracker = createTracker();
    const sleep = vi.fn(() => Promise.resolve(undefined));

    // pollIntervalMs 1000 + sessionStartTimeoutMs 3000 => the guard trips after
    // 3 "waiting for session to start" polls, instead of looping forever.
    const input: ProcessProjectWorkInput = {
      projectId: startedExecution.projectId,
      batchSize: 1,
      concurrency: 1,
      pollIntervalMs: 1_000,
      leaseDurationSeconds: 30,
      workerId: "worker-1",
      preserveRuntimeOnComplete: true,
      once: true,
      sessionStartTimeoutMs: 3_000,
    };

    const deps: ProcessProjectWorkDeps = {
      workerClient: {
        userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
        claimStepExecutions: vi.fn(),
        heartbeatStepExecution: vi.fn(),
        failStepExecution: vi.fn(() => Promise.resolve(undefined)),
        completeStepExecution: vi.fn(() => Promise.resolve(undefined)),
        getStepExecution: vi.fn(() =>
          Promise.resolve({ status: "running" as const }),
        ),
        getStepExecutionWorkerContext: vi.fn(),
        createArtifactUploadUrl: vi.fn(),
        recordArtifact: vi.fn(),
        appendStepExecutionLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
      },
      createRunTracker: vi.fn(),
      runtimeEnvironmentOrchestrator: {
        launch: vi.fn(),
      },
      agentRunner: {
        promptAsync: vi.fn(),
        // The session never reports running and never writes findings — the
        // failure mode when the in-container agent cannot reach the AI host.
        getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
        sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
      },
      artifactStore: {
        saveArtifact: vi.fn(),
      },
      sleep,
      logger: {
        debug: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
      },
    };

    await expectRejects(
      () =>
        monitorStartedClaimedExecution(
          input,
          deps,
          tracker,
          startedExecution,
          { stop: vi.fn(() => Promise.resolve()) },
          { flush: vi.fn(() => Promise.resolve()) },
        ),
      /never started/u,
    );

    // Bounded: it slept ~3 poll intervals rather than spinning indefinitely.
    expect(sleep).toHaveBeenCalledTimes(3);
    // The claimed step is failed rather than left hanging.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.markFailed).toHaveBeenCalledTimes(1);
  });
});
