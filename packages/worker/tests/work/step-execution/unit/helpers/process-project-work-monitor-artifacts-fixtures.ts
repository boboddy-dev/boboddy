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
  StartedClaimedExecution,
  StepExecutionRunTracker,
} from "../../../../../src/work/step-execution/contracts/process-project-work-types";

export function createStartedExecution(
  workspacePath: string,
): StartedClaimedExecution {
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

export function createTracker(): StepExecutionRunTracker {
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

export const stopStub = () => ({ stop: vi.fn(() => Promise.resolve()) });

export const resultSchema = {
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
export function createDeps(config: {
  callOrder: string[];
  saveArtifact: ReturnType<typeof vi.fn>;
  completeStepExecution: ReturnType<typeof vi.fn>;
  finalStepStatus: "succeeded" | "running";
  getSessionStatus: ProcessProjectWorkDeps["agentRunner"]["getSessionStatus"];
  prune?: ReturnType<typeof vi.fn>;
  recordArtifactFailure?: ReturnType<typeof vi.fn>;
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
      recordArtifactFailure: config.recordArtifactFailure ?? vi.fn(),
      appendStepExecutionLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
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
