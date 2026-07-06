import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { STEP_EXECUTION_AGENT } from "@boboddy/opencode-plugin";
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
const flushStub = () => ({ flush: vi.fn(() => Promise.resolve()) });

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
      const input = createInput(startedExecution);
      let statusCall = 0;
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
          createArtifactUploadUrl: vi.fn(), recordArtifact: vi.fn(),
          appendStepExecutionLogs: vi.fn(() =>
            Promise.resolve({ nextOffset: 0 }),
          ),
        },
        createRunTracker: vi.fn(),
        runtimeEnvironmentOrchestrator: {
          launch: vi.fn(),
        },
        agentRunner: {
          promptAsync: vi.fn(),
          // Poll 1: session has actually started (busy). Later polls: stopped
          // without findings, driving the retry-then-fail flow.
          getSessionStatus: vi.fn(() => {
            statusCall += 1;
            return statusCall === 1
              ? Promise.resolve({ running: true })
              : Promise.resolve({ running: false });
          }),
          sendRetryPrompt,
        },
        artifactStore: {
          saveArtifact: vi.fn(),
        },
        sleep: vi.fn(() => Promise.resolve(undefined)),
        logger: {
          debug: vi.fn(),
          log: vi.fn(),
          error: vi.fn(),
        },
      };

      expect(
        monitorStartedClaimedExecution(input, deps, tracker, startedExecution, stopStub(), flushStub()),
      ).rejects.toThrow(
        /without findings submission via boboddy-submit-step-findings/,
      );

      expect(sendRetryPrompt).toHaveBeenCalledWith({
        agentBaseUrl: startedExecution.environment.agentBaseUrl,
        workspaceFolder: startedExecution.environment.workspaceFolder,
        sessionId: startedExecution.agentSessionId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        promptText: expect.stringContaining(
          "Use the `boboddy-submit-step-findings` tool now.",
        ),
        agent: STEP_EXECUTION_AGENT,
      });
      // The monitor no longer marks the step failed itself: it only throws.
      // scheduleClaimedStepExecutionJob owns failStepExecution and calls it
      // *after* flushing the log stream, so buffered failure logs reach the
      // platform while the step is still "running".
      expect(failStepExecution).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "logs a distinct diagnostic when the AI provider reports an error",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-provider-error-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
      const tracker = createTracker();
      const log = vi.fn();
      const input = createInput(startedExecution);
      let statusCall = 0;
      const deps: ProcessProjectWorkDeps = {
        workerClient: {
          userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
          claimStepExecutions: vi.fn(),
          heartbeatStepExecution: vi.fn(),
          failStepExecution: vi.fn(() => Promise.resolve(undefined)),
          completeStepExecution: vi.fn(),
          getStepExecution: vi.fn(() =>
            Promise.resolve({ status: "running" as const }),
          ),
          getStepExecutionWorkerContext: vi.fn(),
          createArtifactUploadUrl: vi.fn(), recordArtifact: vi.fn(),
          appendStepExecutionLogs: vi.fn(() =>
            Promise.resolve({ nextOffset: 0 }),
          ),
        },
        createRunTracker: vi.fn(),
        runtimeEnvironmentOrchestrator: {
          launch: vi.fn(),
        },
        agentRunner: {
          promptAsync: vi.fn(),
          getSessionStatus: vi.fn(() => {
            statusCall += 1;
            // First poll: provider is retrying after a server error. Later
            // polls: session stopped, driving the run to its terminal failure.
            return statusCall === 1
              ? Promise.resolve({
                  running: true,
                  providerError: {
                    attempt: 7,
                    message:
                      "An error occurred while processing your request. Please include the request ID req-123.",
                  },
                })
              : Promise.resolve({ running: false });
          }),
          sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
        },
        artifactStore: {
          saveArtifact: vi.fn(),
        },
        sleep: vi.fn(() => Promise.resolve(undefined)),
        logger: {
          debug: vi.fn(),
          log,
          error: vi.fn(),
        },
      };

      expect(
        monitorStartedClaimedExecution(input, deps, tracker, startedExecution, stopStub(), flushStub()),
      ).rejects.toThrow(
        /without findings submission via boboddy-submit-step-findings/,
      );

      expect(log).toHaveBeenCalledWith(
        "worker",
        "AI provider error while running step",
        expect.objectContaining({
          attempt: 7,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          providerMessage: expect.stringContaining("request ID req-123"),
        }),
      );
    },
  );

  test.concurrent(
    "collects step artifacts written after a transient stop, once findings are submitted",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-artifacts-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
      const tracker = createTracker();

      await writeCurrentExecutionInfoFile(workspacePath, {
        stepExecutionId: startedExecution.stepExecutionId,
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
          },
        },
      });

      const stepArtifactsDir = path.join(
        workspacePath,
        ".boboddy",
        "step-artifacts",
      );

      const saveArtifact = vi.fn(() =>
        Promise.resolve({ storeRef: "store-ref", sizeBytes: 1 }),
      );

      const input = createInput(startedExecution);

      let statusCall = 0;
      const deps: ProcessProjectWorkDeps = {
        workerClient: {
          userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
          claimStepExecutions: vi.fn(),
          heartbeatStepExecution: vi.fn(),
          failStepExecution: vi.fn(() => Promise.resolve(undefined)),
          completeStepExecution: vi.fn(() => Promise.resolve(undefined)),
          getStepExecution: vi.fn(() =>
            Promise.resolve({ status: "succeeded" as const }),
          ),
          getStepExecutionWorkerContext: vi.fn(),
          createArtifactUploadUrl: vi.fn(), recordArtifact: vi.fn(),
          appendStepExecutionLogs: vi.fn(() =>
            Promise.resolve({ nextOffset: 0 }),
          ),
        },
        createRunTracker: vi.fn(),
        runtimeEnvironmentOrchestrator: {
          launch: vi.fn(),
        },
        agentRunner: {
          promptAsync: vi.fn(),
          getSessionStatus: vi.fn(async () => {
            statusCall += 1;
            // Poll 1: the session has actually started (busy). Poll 2: it
            // briefly reports stopped before it has written any artifacts
            // (mirrors the worker's "wait one poll for late writes" behavior).
            // Poll 3: the agent has finished, writing its artifacts and findings
            // just before stopping.
            if (statusCall === 1) {
              return { running: true };
            }
            if (statusCall === 2) {
              return { running: false };
            }
            await mkdir(stepArtifactsDir, { recursive: true });
            await writeFile(
              path.join(stepArtifactsDir, "trace.zip"),
              "trace-bytes",
              "utf8",
            );
            await writeFile(
              buildFindingsSubmissionPath(workspacePath),
              `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
              "utf8",
            );
            return { running: false };
          }),
          sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
        },
        artifactStore: {
          saveArtifact,
        },
        sleep: vi.fn(() => Promise.resolve(undefined)),
        logger: {
          debug: vi.fn(),
          log: vi.fn(),
          error: vi.fn(),
        },
      };

      await monitorStartedClaimedExecution(input, deps, tracker, startedExecution, stopStub(), flushStub());

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
    "does not misfire the missing-findings flow before the agent session starts",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-slow-start-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
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

      const log = vi.fn();
      const sendRetryPrompt = vi.fn(() => Promise.resolve(undefined));

      const input = createInput(startedExecution);

      let statusCall = 0;
      const deps: ProcessProjectWorkDeps = {
        workerClient: {
          userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
          claimStepExecutions: vi.fn(),
          heartbeatStepExecution: vi.fn(),
          failStepExecution: vi.fn(() => Promise.resolve(undefined)),
          completeStepExecution: vi.fn(() => Promise.resolve(undefined)),
          getStepExecution: vi.fn(() =>
            Promise.resolve({ status: "succeeded" as const }),
          ),
          getStepExecutionWorkerContext: vi.fn(),
          createArtifactUploadUrl: vi.fn(), recordArtifact: vi.fn(),
          appendStepExecutionLogs: vi.fn(() =>
            Promise.resolve({ nextOffset: 0 }),
          ),
        },
        createRunTracker: vi.fn(),
        runtimeEnvironmentOrchestrator: {
          launch: vi.fn(),
        },
        agentRunner: {
          promptAsync: vi.fn(),
          // Poll 1: prompt was queued but the session has not begun streaming
          // yet, so it still reports "not running" (the startup race). Poll 2:
          // the agent is now busy. Poll 3: the agent finished and wrote findings
          // just before stopping.
          getSessionStatus: vi.fn(async () => {
            statusCall += 1;
            if (statusCall === 1) {
              return { running: false };
            }
            if (statusCall === 2) {
              return { running: true };
            }
            await writeFile(
              buildFindingsSubmissionPath(workspacePath),
              `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
              "utf8",
            );
            return { running: false };
          }),
          sendRetryPrompt,
        },
        artifactStore: {
          saveArtifact: vi.fn(() =>
            Promise.resolve({ storeRef: "store-ref", sizeBytes: 1 }),
          ),
        },
        sleep: vi.fn(() => Promise.resolve(undefined)),
        logger: {
          debug: vi.fn(),
          log,
          error: vi.fn(),
        },
      };

      await monitorStartedClaimedExecution(input, deps, tracker, startedExecution, stopStub(), flushStub());

      // The startup "not running yet" poll must not be mistaken for a finished
      // run: no missing-findings wait/retry should fire, and no retry prompt
      // should be sent.
      expect(log).not.toHaveBeenCalledWith(
        "worker",
        "OpenCode session stopped without findings submission; waiting one poll for late file writes before retrying",
        expect.anything(),
      );
      expect(sendRetryPrompt).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "worker",
        "Waiting for agent session to start",
        expect.anything(),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).toHaveBeenCalledTimes(1);
    },
  );
});
