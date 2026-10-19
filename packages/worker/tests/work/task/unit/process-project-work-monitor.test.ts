import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { TASK_AGENT } from "@boboddy/opencode-plugin";
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
import { buildTestZip } from "../../../support/build-test-zip";

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

function createInput(
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

const stopStub = () => ({ stop: vi.fn(() => Promise.resolve()) });
const flushStub = () => ({ flush: vi.fn(() => Promise.resolve()) });

describe("monitorStartedClaimedTask", () => {
  test.concurrent(
    "uses the configured task agent when retrying findings submission",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-retry-agent-"),
      );
      const startedTask = createStartedTask(workspacePath);
      const sendRetryPrompt = vi.fn(() => Promise.resolve(undefined));
      const failTask = vi.fn(() => Promise.resolve(undefined));
      const tracker = createTracker();
      const input = createInput(startedTask);
      let statusCall = 0;
      const deps: ProcessProjectWorkDeps = {
        workerClient: {
          userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
          claimTasks: vi.fn(),
          heartbeatTask: vi.fn(),
          failTask,
          completeTask: vi.fn(),
          getTask: vi.fn(() =>
            Promise.resolve({ status: "running" as const }),
          ),
          getTaskWorkerContext: vi.fn(),
          createArtifactUploadUrl: vi.fn(), recordArtifact: vi.fn(), recordArtifactFailure: vi.fn(),
          appendTaskLogs: vi.fn(() =>
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
        monitorStartedClaimedTask(input, deps, tracker, startedTask, stopStub(), flushStub()),
      ).rejects.toThrow(
        /without findings submission via boboddy-submit-step-findings/,
      );

      const { agent, workspaceFolder } = startedTask.environment;
      expect(sendRetryPrompt).toHaveBeenCalledWith({
        server: { baseUrl: agent?.baseUrl, password: agent?.password, workspaceFolder },
        sessionId: startedTask.agentSessionId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        promptText: expect.stringContaining(
          "Use the `boboddy-submit-step-findings` tool now.",
        ),
        agent: TASK_AGENT,
      });
      // The monitor no longer marks the step failed itself: it only throws.
      // scheduleClaimedTaskJob owns failTask and calls it
      // *after* flushing the log stream, so buffered failure logs reach the
      // platform while the step is still "running".
      expect(failTask).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "logs a distinct diagnostic when the AI provider reports an error",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-monitor-provider-error-"),
      );
      const startedTask = createStartedTask(workspacePath);
      const tracker = createTracker();
      const log = vi.fn();
      const input = createInput(startedTask);
      let statusCall = 0;
      const deps: ProcessProjectWorkDeps = {
        workerClient: {
          userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
          claimTasks: vi.fn(),
          heartbeatTask: vi.fn(),
          failTask: vi.fn(() => Promise.resolve(undefined)),
          completeTask: vi.fn(),
          getTask: vi.fn(() =>
            Promise.resolve({ status: "running" as const }),
          ),
          getTaskWorkerContext: vi.fn(),
          createArtifactUploadUrl: vi.fn(), recordArtifact: vi.fn(), recordArtifactFailure: vi.fn(),
          appendTaskLogs: vi.fn(() =>
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
        monitorStartedClaimedTask(input, deps, tracker, startedTask, stopStub(), flushStub()),
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
      const startedTask = createStartedTask(workspacePath);
      const tracker = createTracker();

      await writeCurrentExecutionInfoFile(workspacePath, {
        taskId: startedTask.taskId,
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

      const input = createInput(startedTask);

      let statusCall = 0;
      const deps: ProcessProjectWorkDeps = {
        workerClient: {
          userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
          claimTasks: vi.fn(),
          heartbeatTask: vi.fn(),
          failTask: vi.fn(() => Promise.resolve(undefined)),
          completeTask: vi.fn(() => Promise.resolve(undefined)),
          getTask: vi.fn(() =>
            Promise.resolve({ status: "succeeded" as const }),
          ),
          getTaskWorkerContext: vi.fn(),
          createArtifactUploadUrl: vi.fn(), recordArtifact: vi.fn(), recordArtifactFailure: vi.fn(),
          appendTaskLogs: vi.fn(() =>
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
              buildTestZip(["trace.trace", "trace.network"]),
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

      await monitorStartedClaimedTask(input, deps, tracker, startedTask, stopStub(), flushStub());

      expect(saveArtifact).toHaveBeenCalledTimes(1);
      expect(saveArtifact).toHaveBeenCalledWith({
        taskId: startedTask.taskId,
        claimToken: startedTask.claimToken,
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
      const startedTask = createStartedTask(workspacePath);
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

      const log = vi.fn();
      const sendRetryPrompt = vi.fn(() => Promise.resolve(undefined));

      const input = createInput(startedTask);

      let statusCall = 0;
      const deps: ProcessProjectWorkDeps = {
        workerClient: {
          userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
          claimTasks: vi.fn(),
          heartbeatTask: vi.fn(),
          failTask: vi.fn(() => Promise.resolve(undefined)),
          completeTask: vi.fn(() => Promise.resolve(undefined)),
          getTask: vi.fn(() =>
            Promise.resolve({ status: "succeeded" as const }),
          ),
          getTaskWorkerContext: vi.fn(),
          createArtifactUploadUrl: vi.fn(), recordArtifact: vi.fn(), recordArtifactFailure: vi.fn(),
          appendTaskLogs: vi.fn(() =>
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

      await monitorStartedClaimedTask(input, deps, tracker, startedTask, stopStub(), flushStub());

      // The startup "not running yet" poll must not be mistaken for a finished
      // run: no missing-findings wait/retry should fire, and no retry prompt
      // should be sent.
      expect(log).not.toHaveBeenCalledWith(
        "worker",
        "OpenCode session stopped without findings submission; waiting for late file writes before retrying",
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
