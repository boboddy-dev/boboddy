/**
 * Coverage for `startProcessClaimedExecution`'s `kind === "code"` branch
 * (`process-claimed-step-execution.ts`). Injects a fake `runCodeStepCommand`
 * (mirroring `deps.runHealthChecks`/`deps.createFakeAiServer`'s existing
 * override seams) so `execute-code-step.ts`'s real dispatch never shells out
 * to a real `docker`/`sh` binary — matching this suite's "no real Docker"
 * convention. `execute-code-step.ts`'s own unit tests separately cover the
 * real runner-script/temp-file mechanics against a fake command runner; this
 * file only covers the BRANCH wiring in `process-claimed-step-execution.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { startProcessClaimedExecution } from "../../../../src/work/step-execution/application/process-claimed-step-execution";
import type { RunCodeStepCommand } from "../../../../src/work/step-execution/application/execute-code-step";
import type { ProcessProjectWorkDeps } from "../../../../src/work/step-execution/contracts/process-project-work-types";
import {
  createCodeStepWorkerContext,
  createRunTracker,
  createWorkerClient,
  projectId,
  requestedByUserId,
  stepExecutionId,
} from "./helpers/claimed-step-execution-fixtures";

describe("startProcessClaimedExecution kind: 'code' branch", () => {
  let workspacePath: string;

  afterEach(async () => {
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function buildDeps(input: {
    entrypointJson: { sourceFile: string; exportName: string };
    runCodeStepCommand: ProcessProjectWorkDeps["runCodeStepCommand"];
  }): {
    deps: ProcessProjectWorkDeps;
    tracker: ReturnType<typeof createRunTracker>;
    launch: ReturnType<typeof vi.fn>;
  } {
    const launch = vi.fn(() =>
      Promise.resolve({
        workspacePath,
        workspaceFolder: "/workspaces/repo",
        opencodeLogDirectory: path.join(workspacePath, ".logs"),
        resolvedBranch: "main",
        workBranch: null,
        createdFromBranch: null,
        devcontainerConfigPath: ".devcontainer/devcontainer.json",
        runtimeContainerId: "runtime-container-id",
        agentBaseUrl: "http://localhost:4096",
        aiImage: "boboddy/ai-worker:local",
        networkName: "test-network",
        secretValues: [],
        cleanup: () => Promise.resolve(),
      }),
    );

    const workerClient = createWorkerClient();
    workerClient.getStepExecutionWorkerContext = vi.fn(() =>
      Promise.resolve(createCodeStepWorkerContext(input.entrypointJson)),
    );

    const tracker = createRunTracker();
    const deps = {
      workerClient,
      createRunTracker: () => tracker,
      runtimeEnvironmentOrchestrator: { launch },
      agentRunner: {
        promptAsync: vi.fn(() =>
          Promise.reject(
            new Error("promptAsync must not be called for a code step"),
          ),
        ),
        getSessionStatus: vi.fn(),
        sendRetryPrompt: vi.fn(),
      },
      artifactStore: {
        saveArtifact: vi.fn(),
      },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      runCodeStepCommand: input.runCodeStepCommand,
    } satisfies ProcessProjectWorkDeps;

    return { deps, tracker, launch };
  }

  test("dispatches via the injected command runner, skips promptAsync entirely, and returns a synthetic agentSessionId", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-code-step-branch-"),
    );

    const entrypointJson = {
      sourceFile: ".boboddy/pipeline-builder/review-file-step.ts",
      exportName: "reviewFileStep",
    };
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const { deps, tracker } = buildDeps({ entrypointJson, runCodeStepCommand });

    const result = await startProcessClaimedExecution(
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
      tracker,
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.promptAsync).not.toHaveBeenCalled();
    expect(runCodeStepCommand).toHaveBeenCalledTimes(1);
    const call = runCodeStepCommand.mock.calls[0]?.[0];
    expect(call?.runtimeContainerId).toBe("runtime-container-id");
    expect(call?.shellCommand).toContain(
      ".boboddy/pipeline-builder/review-file-step.ts",
    );
    expect(call?.shellCommand).toContain("reviewFileStep");

    // A synthetic, stable agentSessionId — no real OpenCode session exists.
    expect(result.agentSessionId).toBe(`code-step:${stepExecutionId}`);
    expect(result.stepExecutionId).toBe(stepExecutionId);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading through a plain object, not a class instance
    expect(tracker.markRunning).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.attachAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: `code-step:${stepExecutionId}`,
      }),
    );
  });

  test("propagates a clear error and marks the local session failed when the command runner exits non-zero", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-code-step-branch-fail-"),
    );

    const entrypointJson = {
      sourceFile: "steps/review-step.ts",
      exportName: "reviewFileStep",
    };
    const runCodeStepCommand = vi.fn(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr:
          'module has no exported function named "reviewFileStep"',
      }),
    );
    const { deps, tracker } = buildDeps({ entrypointJson, runCodeStepCommand });

    let caught: unknown;
    try {
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
        tracker,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("exit code 1");
    expect((caught as Error).message).toContain(
      'module has no exported function named "reviewFileStep"',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.promptAsync).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.markFailed).toHaveBeenCalledTimes(1);
  });

  test("throws before dispatching when the step definition is missing entrypointJson", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-code-step-branch-no-entrypoint-"),
    );

    const runCodeStepCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const workerClient = createWorkerClient();
    workerClient.getStepExecutionWorkerContext = vi.fn(() =>
      Promise.resolve(createCodeStepWorkerContext(null)),
    );
    const launch = vi.fn(() =>
      Promise.resolve({
        workspacePath,
        workspaceFolder: "/workspaces/repo",
        opencodeLogDirectory: path.join(workspacePath, ".logs"),
        resolvedBranch: "main",
        workBranch: null,
        createdFromBranch: null,
        devcontainerConfigPath: ".devcontainer/devcontainer.json",
        runtimeContainerId: "runtime-container-id",
        agentBaseUrl: "http://localhost:4096",
        aiImage: "boboddy/ai-worker:local",
        networkName: "test-network",
        secretValues: [],
        cleanup: () => Promise.resolve(),
      }),
    );
    const tracker = createRunTracker();
    const deps = {
      workerClient,
      createRunTracker: () => tracker,
      runtimeEnvironmentOrchestrator: { launch },
      agentRunner: {
        promptAsync: vi.fn(() =>
          Promise.reject(new Error("must not be called")),
        ),
        getSessionStatus: vi.fn(),
        sendRetryPrompt: vi.fn(),
      },
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      runCodeStepCommand,
    } satisfies ProcessProjectWorkDeps;

    let caught: unknown;
    try {
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
        tracker,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("has no entrypointJson");
    expect(runCodeStepCommand).not.toHaveBeenCalled();
  });
});
