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
  createWorkerContext,
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
    entrypointJson: { sourceFile: string };
    runCodeStepCommand: ProcessProjectWorkDeps["runCodeStepCommand"];
    envJson?: Parameters<typeof createCodeStepWorkerContext>[1];
    managedRuntime?: Parameters<typeof createCodeStepWorkerContext>[2];
  }): {
    deps: ProcessProjectWorkDeps;
    tracker: ReturnType<typeof createRunTracker>;
    launch: ReturnType<typeof vi.fn>;
  } {
    const launch = vi.fn(() =>
      Promise.resolve({
        workspacePath,
        workspaceFolder: "/workspaces/repo",
        resolvedBranch: "main",
        workBranch: null,
        createdFromBranch: null,
        devcontainerConfigPath: ".devcontainer/devcontainer.json",
        runtimeContainerId: "runtime-container-id",
        agent: null,
        aiImage: "",
        networkName: "test-network",
        secretValues: [],
        cleanup: () => Promise.resolve(),
      }),
    );

    const workerClient = createWorkerClient();
    workerClient.getStepExecutionWorkerContext = vi.fn(() =>
      Promise.resolve(
        createCodeStepWorkerContext(
          input.entrypointJson,
          input.envJson,
          input.managedRuntime,
        ),
      ),
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

  test("dispatches via the injected command runner, skips promptAsync and the agent entirely, and returns a null agentSessionId", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-code-step-branch-"),
    );

    const entrypointJson = {
      sourceFile: ".boboddy/pipeline-builder/review-file-step.ts",
    };
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const { deps, tracker, launch } = buildDeps({
      entrypointJson,
      runCodeStepCommand,
    });

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
    expect(call?.shellCommand).toContain("'demo-step'");

    expect(result.agentSessionId).toBeNull();
    expect(result.stepExecutionId).toBe(stepExecutionId);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ startAgent: false }),
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading through a plain object, not a class instance
    expect(tracker.markRunning).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.markRunning).toHaveBeenCalledWith(
      expect.objectContaining({ agentBaseUrl: null }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.attachAgentSession).not.toHaveBeenCalled();
  });

  test.each([
    ["bun1", "bun run"],
    ["node24", "node '"],
  ])(
    "a managed %s step reaches the launch and invokes its runtime directly",
    async (managedRuntime, invocation) => {
      workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-code-step-branch-managed-"),
      );
      const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
        Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      );
      const { deps, tracker, launch } = buildDeps({
        entrypointJson: { sourceFile: "steps/review.ts" },
        runCodeStepCommand,
        managedRuntime,
      });

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

      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({ managedRuntime, startAgent: false }),
      );
      const shellCommand = runCodeStepCommand.mock.calls[0]?.[0].shellCommand;
      expect(shellCommand).toContain(invocation);
      expect(shellCommand).not.toContain("command -v");
    },
  );

  test("hands the resolved step env to the command runner, outside the shell command", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-code-step-branch-env-"),
    );

    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const { deps, tracker, launch } = buildDeps({
      entrypointJson: { sourceFile: "steps/review.ts" },
      runCodeStepCommand,
      envJson: [
        {
          name: "ACCOUNT_ID",
          source: "value",
          value: "{{input.title}}-acct",
          secret: false,
        },
        {
          name: "WAREHOUSE_TOKEN",
          source: "inherit",
          from: "WAREHOUSE_TOKEN",
          secret: true,
          optional: false,
        },
      ],
    });

    await startProcessClaimedExecution(
      {
        projectId,
        requestedByUserId,
        claim: {
          stepExecution: { id: stepExecutionId },
          claimToken: "claim-token",
        },
        leaseDurationSeconds: 30,
        workerEnv: { WAREHOUSE_TOKEN: "wh-token-value" },
      },
      deps,
      deps.workerClient,
      tracker,
    );

    const expectedEnv = {
      ACCOUNT_ID: "Checkout bug-acct",
      WAREHOUSE_TOKEN: "wh-token-value",
    };
    expect(runCodeStepCommand.mock.calls[0]?.[0].env).toEqual(expectedEnv);
    expect(runCodeStepCommand.mock.calls[0]?.[0].shellCommand).not.toContain(
      "wh-token-value",
    );
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ stepEnv: expectedEnv }),
    );
  });

  test("propagates a clear error and marks the local session failed when the command runner exits non-zero", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-code-step-branch-fail-"),
    );

    const entrypointJson = {
      sourceFile: "steps/review-step.ts",
    };
    const runCodeStepCommand = vi.fn(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr:
          'no code step with key "demo-step" exported by or embedded in x',
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
      'no code step with key "demo-step" exported by or embedded in x',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deps.agentRunner.promptAsync).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tracker.markFailed).toHaveBeenCalledTimes(1);
  });

  test("rejects a code step in no_workspace mode before launching any runtime", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-code-step-branch-no-workspace-"),
    );

    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const { deps, tracker, launch } = buildDeps({
      entrypointJson: { sourceFile: "steps/review.ts" },
      runCodeStepCommand,
    });
    const noWorkspaceLaunch = vi.fn();
    const noWorkspaceDeps = {
      ...deps,
      noWorkspaceRuntimeEnvironmentOrchestrator: { launch: noWorkspaceLaunch },
    } satisfies ProcessProjectWorkDeps;
    noWorkspaceDeps.workerClient.getStepExecutionWorkerContext = vi.fn(() =>
      Promise.resolve(
        createWorkerContext("no_workspace", null, {
          kind: "code",
          prompt: null,
          entrypointJson: { sourceFile: "steps/review.ts" },
        }),
      ),
    );

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
        noWorkspaceDeps,
        noWorkspaceDeps.workerClient,
        tracker,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("no_workspace");
    expect((caught as Error).message).toContain("require an agent");
    expect(launch).not.toHaveBeenCalled();
    expect(noWorkspaceLaunch).not.toHaveBeenCalled();
    expect(runCodeStepCommand).not.toHaveBeenCalled();
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
        resolvedBranch: "main",
        workBranch: null,
        createdFromBranch: null,
        devcontainerConfigPath: ".devcontainer/devcontainer.json",
        runtimeContainerId: "runtime-container-id",
        agent: null,
        aiImage: "",
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
