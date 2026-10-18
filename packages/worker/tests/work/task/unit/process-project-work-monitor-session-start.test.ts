import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { monitorStartedClaimedTask } from "../../../../src/work/task/application/process-project-work-monitor";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StartedClaimedTask,
  TaskRunTracker,
} from "../../../../src/work/task/contracts/process-project-work-types";

function createStartedTask(workspacePath: string): StartedClaimedTask {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    taskId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003"),
    claimToken: "claim-token",
    agentSessionId: "agent-session-id",
    environment: {
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agent: {
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
        version: "0.0.0-test",
        logDirectory: path.join(workspacePath, ".logs"),
      },
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

describe("monitorStartedClaimedTask session-start fail-fast", () => {
  test("fails fast when the agent session never starts within the timeout", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-monitor-never-start-"),
    );
    const startedTask = createStartedTask(workspacePath);
    const tracker = createTracker();
    const sleep = vi.fn(() => Promise.resolve(undefined));

    // pollIntervalMs 1000 + sessionStartTimeoutMs 3000 => the guard trips after
    // 3 "waiting for session to start" polls, instead of looping forever.
    const input: ProcessProjectWorkInput = {
      projectId: startedTask.projectId,
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
        claimTasks: vi.fn(),
        heartbeatTask: vi.fn(),
        failTask: vi.fn(() => Promise.resolve(undefined)),
        completeTask: vi.fn(() => Promise.resolve(undefined)),
        getTask: vi.fn(() => Promise.resolve({ status: "running" as const })),
        getTaskWorkerContext: vi.fn(),
        createArtifactUploadUrl: vi.fn(),
        recordArtifact: vi.fn(),
        recordArtifactFailure: vi.fn(),
        appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
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
        monitorStartedClaimedTask(
          input,
          deps,
          tracker,
          startedTask,
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
