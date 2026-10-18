/**
 * Shared fixtures for `process-project-work-monitor-artifacts*.test.ts`.
 * Split out so neither test file has to duplicate this scaffolding, and so
 * both stay under the repo's per-file line limit.
 */
import path from "node:path";
import { vi } from "bun:test";
import { parseUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StartedClaimedTask,
  TaskRunTracker,
} from "../../../../../src/work/task/contracts/process-project-work-types";

export function createStartedTask(workspacePath: string): StartedClaimedTask {
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

export function createTracker(): TaskRunTracker {
  return {
    createSession: vi.fn(),
    markRunning: vi.fn(),
    attachAgentSession: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  };
}

export function createInput(
  startedTask: StartedClaimedTask,
): ProcessProjectWorkInput {
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

export const stopStub = () => ({ stop: vi.fn(() => Promise.resolve()) });

export const resultSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string" } },
} as const;

/**
 * Builds a `deps` matching the existing monitor unit test, but wires the
 * provided call-order recorders/spies into `saveArtifact`, `completeTask`,
 * and `getSessionStatus` so ordering and idempotency can be asserted.
 */
export function createDeps(config: {
  callOrder: string[];
  saveArtifact: ReturnType<typeof vi.fn>;
  completeTask: ReturnType<typeof vi.fn>;
  finalStepStatus: "succeeded" | "running";
  getSessionStatus: ProcessProjectWorkDeps["agentRunner"]["getSessionStatus"];
  prune?: ReturnType<typeof vi.fn>;
  recordArtifactFailure?: ReturnType<typeof vi.fn>;
}): ProcessProjectWorkDeps {
  return {
    workerClient: {
      userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
      claimTasks: vi.fn(),
      heartbeatTask: vi.fn(),
      failTask: vi.fn(() => Promise.resolve(undefined)),
      completeTask: config.completeTask,
      getTask: vi.fn(() => Promise.resolve({ status: config.finalStepStatus })),
      getTaskWorkerContext: vi.fn(),
      createArtifactUploadUrl: vi.fn(),
      recordArtifact: vi.fn(),
      recordArtifactFailure: config.recordArtifactFailure ?? vi.fn(),
      appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    },
    createRunTracker: vi.fn(),
    runtimeEnvironmentOrchestrator: { launch: vi.fn() },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: config.getSessionStatus,
      sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
    },
    artifactStore: {
      saveArtifact: config.saveArtifact,
      ...(config.prune ? { prune: config.prune } : {}),
    },
    sleep: vi.fn(() => Promise.resolve(undefined)),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
  };
}
