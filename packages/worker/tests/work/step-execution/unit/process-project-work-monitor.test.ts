import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { STEP_EXECUTION_AGENT } from "@boboddy/opencode-plugin";
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
      opencodeLogDirectory: path.join(workspacePath, ".logs"),
      resolvedBranch: "main",
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      devcontainerId: "devcontainer-id",
      aiContainerId: "ai-container-id",
      aiBaseUrl: "http://127.0.0.1:4096",
      aiImage: "boboddy/ai-worker:local",
      networkName: "test-network",
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

describe("monitorStartedClaimedExecution", () => {
  test.concurrent(
    "uses the configured step execution agent when retrying findings submission",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-retry-agent-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
      const sendRetryPrompt = vi.fn(() => Promise.resolve(undefined));
      const failStepExecution = vi.fn(() => Promise.resolve(undefined));
      const tracker = createTracker();
      const input: ProcessProjectWorkInput = {
        projectId: startedExecution.projectId,
        batchSize: 1,
        concurrency: 1,
        pollIntervalMs: 0,
        leaseDurationSeconds: 30,
        workerId: "worker-1",
        preserveRuntimeOnComplete: true,
        once: true,
      };
      const deps: ProcessProjectWorkDeps = {
        workerClient: {
          userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
          claimStepExecutions: vi.fn(),
          heartbeatStepExecution: vi.fn(),
          failStepExecution,
          completeStepExecution: vi.fn(),
          getStepExecution: vi.fn(() =>
            Promise.resolve({ status: "running" as const }),
          ),
          getStepExecutionWorkerContext: vi.fn(),
        },
        createRunTracker: vi.fn(),
        runtimeEnvironmentOrchestrator: {
          launch: vi.fn(),
        },
        agentRunner: {
          promptAsync: vi.fn(),
          getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
          sendRetryPrompt,
        },
        artifactStore: {
          saveArtifact: vi.fn(),
        },
        sleep: vi.fn(() => Promise.resolve(undefined)),
        logger: {
          log: vi.fn(),
          error: vi.fn(),
        },
      };

      await expect(
        monitorStartedClaimedExecution(
          input,
          deps,
          tracker,
          startedExecution,
          { stop: vi.fn(() => Promise.resolve()) },
        ),
      ).rejects.toThrow(
        /without findings submission via boboddy-submit-step-findings/,
      );

      expect(sendRetryPrompt).toHaveBeenCalledWith({
        aiBaseUrl: startedExecution.environment.aiBaseUrl,
        sessionId: startedExecution.agentSessionId,
        promptText: expect.stringContaining(
          "Use the `boboddy-submit-step-findings` tool now.",
        ),
        agent: STEP_EXECUTION_AGENT,
      });
      expect(failStepExecution).toHaveBeenCalledTimes(1);
    },
  );
});
