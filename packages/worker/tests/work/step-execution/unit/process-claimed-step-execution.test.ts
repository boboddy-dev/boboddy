import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { startProcessClaimedExecution } from "../../../../src/work/step-execution/application/process-claimed-step-execution";
import type {
  ProcessProjectWorkDeps,
  StepExecutionWorkerClient,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";
import {
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  projectId,
  requestedByUserId,
  runClaim,
  stepExecutionId,
} from "./helpers/claimed-step-execution-fixtures";

/**
 * A recording runtime-environment orchestrator: its `launch` resolves the same
 * fake environment the existing test uses, but records that it was invoked so
 * routing between the `workspace` and `no_workspace` orchestrators can be
 * asserted through the exported {@link startProcessClaimedExecution} seam
 * (`resolveRuntimeEnvironmentOrchestrator` itself is module-private).
 */
function createRecordingOrchestrator(workspacePath: string) {
  const launch = vi.fn(() =>
    Promise.resolve({
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      opencodeLogDirectory: path.join(workspacePath, ".logs"),
      resolvedBranch: "",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: "",
      runtimeContainerId: null,
      agentBaseUrl: "http://localhost:4096",
      aiImage: "opencode-runtime@test",
      networkName: "",
      secretValues: [],
      cleanup: () => Promise.resolve(),
    }),
  );
  return { launch };
}

function createRoutingDeps(input: {
  workerClient: StepExecutionWorkerClient;
  workspaceOrchestrator: { launch: ReturnType<typeof vi.fn> };
  noWorkspaceOrchestrator?: { launch: ReturnType<typeof vi.fn> } | undefined;
}): ProcessProjectWorkDeps {
  return {
    workerClient: input.workerClient,
    createRunTracker,
    runtimeEnvironmentOrchestrator: input.workspaceOrchestrator,
    ...(input.noWorkspaceOrchestrator
      ? { noWorkspaceRuntimeEnvironmentOrchestrator: input.noWorkspaceOrchestrator }
      : {}),
    agentRunner: {
      promptAsync: vi.fn(() =>
        Promise.resolve({ sessionId: "agent-session-id" }),
      ),
      getSessionStatus: vi.fn(),
      sendRetryPrompt: vi.fn(),
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
  } satisfies ProcessProjectWorkDeps;
}

describe("startProcessClaimedExecution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["BASE_URL"];
  });

  test("passes the server-handed baseWorkBranch to the runtime launch", async () => {
    process.env["BASE_URL"] = "https://app.example.com";

    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-claimed-step-"),
    );
    const launch = vi.fn(() =>
      Promise.resolve({
        workspacePath,
        // Representative resolved workspace folder: the prompt's artifact paths
        // must be anchored here rather than a hardcoded `/workspace`.
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
      Promise.resolve({
        ...createWorkerContext(),
        baseWorkBranch: "boboddy/prev-step",
      }),
    );

    const deps = {
      workerClient,
      createRunTracker,
      runtimeEnvironmentOrchestrator: { launch },
      agentRunner: {
        promptAsync: vi.fn(() =>
          Promise.resolve({ sessionId: "agent-session-id" }),
        ),
        getSessionStatus: vi.fn(),
        sendRetryPrompt: vi.fn(),
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
        baseWorkBranch: "boboddy/prev-step",
      }),
    );
    expect(deps.agentRunner.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceFolder: "/workspaces/repo",
        promptText:
          "Header\nOpen https://app.example.com for Checkout bug and save to /workspaces/repo/.boboddy/step-artifacts/trace.zip. Legacy: Checkout bug and /workspaces/repo/.boboddy/step-artifacts/trace.zip.\nFooter",
      }),
    );
  });

  test("attaches the conversation stream via onSessionCreated, before the prompt resolves", async () => {
    // Regression test for the missing-initial-prompt bug: attaching the
    // conversation stream after `agentRunner.promptAsync` resolves is too
    // late, because OpenCode broadcasts the initial user message's text part
    // exactly once, synchronously while handling the prompt request. The fix
    // wires `attachConversationStream` through the `onSessionCreated` hook so
    // it runs before the prompt is submitted, not after.
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-claimed-step-conversation-"),
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

    const callOrder: string[] = [];
    const attachConversationStream = vi.fn((input: { sessionId: string }) => {
      callOrder.push(`attachConversationStream:${input.sessionId}`);
    });
    const logStream = {
      registerSecretValues: vi.fn(),
      attachOpencodeTail: vi.fn(),
      attachConversationStream,
      shipDevcontainerLogLine: vi.fn(),
    };

    const deps = {
      workerClient: createWorkerClient(),
      createRunTracker,
      runtimeEnvironmentOrchestrator: { launch },
      agentRunner: {
        promptAsync: vi.fn(
          async (input: {
            onSessionCreated?: (result: {
              sessionId: string;
            }) => void | Promise<void>;
          }) => {
            callOrder.push("promptAsync:start");
            await input.onSessionCreated?.({ sessionId: "agent-session-id" });
            callOrder.push("promptAsync:resolve");
            return { sessionId: "agent-session-id" };
          },
        ),
        getSessionStatus: vi.fn(),
        sendRetryPrompt: vi.fn(),
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
      logStream,
    );

    expect(attachConversationStream).toHaveBeenCalledWith({
      agentBaseUrl: "http://localhost:4096",
      workspaceFolder: "/workspaces/repo",
      sessionId: "agent-session-id",
    });
    // The critical assertion: the stream is attached WHILE promptAsync is
    // still in flight (via onSessionCreated), strictly before it resolves —
    // not afterward, which is what reintroduced the race this test guards.
    expect(callOrder).toEqual([
      "promptAsync:start",
      "attachConversationStream:agent-session-id",
      "promptAsync:resolve",
    ]);
  });
});

/**
 * Routing coverage for `resolveRuntimeEnvironmentOrchestrator`. That helper is
 * module-private, so its behavior is exercised through the exported
 * `startProcessClaimedExecution` seam by varying the worker context's
 * `stepDefinition.executionMode` and asserting which orchestrator's `launch`
 * ran (matching the existing test's fake-deps style).
 */
describe("startProcessClaimedExecution runtime orchestrator routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("routes 'no_workspace' steps to the no-workspace orchestrator", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-routing-nws-"),
    );
    const workspaceOrchestrator = createRecordingOrchestrator(workspacePath);
    const noWorkspaceOrchestrator = createRecordingOrchestrator(workspacePath);
    const deps = createRoutingDeps({
      workerClient: createWorkerClient("no_workspace"),
      workspaceOrchestrator,
      noWorkspaceOrchestrator,
    });

    await runClaim(deps);

    expect(noWorkspaceOrchestrator.launch).toHaveBeenCalledTimes(1);
    expect(workspaceOrchestrator.launch).not.toHaveBeenCalled();
  });

  test("routes 'workspace' steps to the default orchestrator", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-routing-ws-"),
    );
    const workspaceOrchestrator = createRecordingOrchestrator(workspacePath);
    const noWorkspaceOrchestrator = createRecordingOrchestrator(workspacePath);
    const deps = createRoutingDeps({
      workerClient: createWorkerClient("workspace"),
      workspaceOrchestrator,
      noWorkspaceOrchestrator,
    });

    await runClaim(deps);

    expect(workspaceOrchestrator.launch).toHaveBeenCalledTimes(1);
    expect(noWorkspaceOrchestrator.launch).not.toHaveBeenCalled();
  });

  test("throws a clear error for 'no_workspace' when the orchestrator is not configured", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-routing-missing-"),
    );
    const workspaceOrchestrator = createRecordingOrchestrator(workspacePath);
    const deps = createRoutingDeps({
      workerClient: createWorkerClient("no_workspace"),
      workspaceOrchestrator,
      // noWorkspaceRuntimeEnvironmentOrchestrator intentionally omitted.
    });

    let caught: unknown;
    try {
      await runClaim(deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /no_workspace execution mode but no/,
    );
    expect(workspaceOrchestrator.launch).not.toHaveBeenCalled();
  });
});
