import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { startProcessClaimedExecution } from "../../../../src/work/step-execution/application/process-claimed-step-execution";
import type {
  ProcessProjectWorkDeps,
  StepExecutionRunTracker,
  StepExecutionWorkerClient,
  StepExecutionWorkerContext,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";

const projectId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001");
const requestedByUserId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002");
const stepExecutionId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");
const stepDefinitionId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004");

function createWorkerContext(): StepExecutionWorkerContext {
  return {
    projectId,
    gitUrl: "https://github.com/example/repo.git",
    requestedBranch: null,
    projectOpencodeConfig: {
      relativePath: ".boboddy/boboddy.jsonc",
      present: false,
      commands: [],
      services: [],
    },
    stepExecution: {
      id: stepExecutionId,
      status: "running",
      inputJson: null,
      executionTimeoutSeconds: 120,
    },
    stepDefinition: {
      id: stepDefinitionId,
      key: "demo-step",
      name: "Demo Step",
      prompt: "Run the demo step.",
      resultSchemaJson: { type: "object" },
      opencodeMcpJson: null,
      opencodePluginJson: null,
    },
    agentPrompt: {
      sessionTitle: "Demo Step",
      promptText: "Run it.",
    },
  };
}

function createRunTracker(): StepExecutionRunTracker {
  return {
    createSession: vi.fn(() => Promise.resolve(undefined)),
    markRunning: vi.fn(() => Promise.resolve(undefined)),
    attachAgentSession: vi.fn(() => Promise.resolve(undefined)),
    markSucceeded: vi.fn(() => Promise.resolve(undefined)),
    markFailed: vi.fn(() => Promise.resolve(undefined)),
    close: vi.fn(() => Promise.resolve(undefined)),
  };
}

function createWorkerClient(): StepExecutionWorkerClient {
  return {
    userId: requestedByUserId,
    claimStepExecutions: vi.fn(),
    heartbeatStepExecution: vi.fn(),
    failStepExecution: vi.fn(),
    completeStepExecution: vi.fn(),
    getStepExecution: vi.fn(),
    getStepExecutionWorkerContext: vi.fn(() => Promise.resolve(createWorkerContext())),
  };
}

describe("startProcessClaimedExecution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["BOBODDY_WORK_REQUESTED_BRANCH"];
  });

  test("falls back to the worker branch env var when worker context omits requestedBranch", async () => {
    process.env["BOBODDY_WORK_REQUESTED_BRANCH"] = "upgrade-ajv";

    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-claimed-step-"),
    );
    const launch = vi.fn(() =>
      Promise.resolve({
        workspacePath,
        opencodeLogDirectory: path.join(workspacePath, ".logs"),
        resolvedBranch: "upgrade-ajv",
        devcontainerConfigPath: ".devcontainer/devcontainer.json",
        devcontainerId: "devcontainer-id",
        aiContainerId: "ai-container-id",
        aiBaseUrl: "http://localhost:4096",
        aiImage: "boboddy/ai-worker:local",
        networkName: "test-network",
        cleanup: () => Promise.resolve(),
      }),
    );

    const deps = {
      workerClient: createWorkerClient(),
      createRunTracker,
      runtimeEnvironmentOrchestrator: { launch },
      agentRunner: {
        promptAsync: vi.fn(() => Promise.resolve({ sessionId: "agent-session-id" })),
        getSessionStatus: vi.fn(),
        sendRetryPrompt: vi.fn(),
      },
      artifactStore: {
        saveArtifact: vi.fn(),
      },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: {
        log: vi.fn(),
        error: vi.fn(),
      },
    } satisfies ProcessProjectWorkDeps;

    await startProcessClaimedExecution(
      {
        projectId,
        requestedByUserId,
        claim: {
          stepExecution: { id: stepExecutionId },
          claimToken: "claim-token",
        },
        leaseDurationSeconds: 30,
      },
      deps,
      deps.workerClient,
      createRunTracker(),
    );

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBranch: "upgrade-ajv",
      }),
    );
  });
});
