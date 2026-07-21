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

function createWorkerContext(
  executionMode: "workspace" | "no_workspace" = "workspace",
): StepExecutionWorkerContext {
  return {
    projectId,
    gitUrl: "https://github.com/example/repo.git",
    projectOpencodeConfig: {
      relativePath: ".boboddy/boboddy.jsonc",
      present: false,
      commands: [],
      services: [],
    },
    stepExecution: {
      id: stepExecutionId,
      status: "running",
      inputJson: { title: "Checkout bug" },
      executionTimeoutSeconds: 120,
    },
    stepDefinition: {
      id: stepDefinitionId,
      key: "demo-step",
      name: "Demo Step",
      prompt:
        "Open {{env.BASE_URL}} for {{input.title}} and save to {{boboddy.artifactsDir}}trace.zip. Legacy: {{title}} and {{stepArtifactsDir}}trace.zip.",
      executionMode,
      resultSchemaJson: { type: "object" },
      opencodeMcpJson: null,
      opencodePluginJson: null,
    },
    agentPrompt: {
      sessionTitle: "Demo Step",
      promptText: "Header\n__BOBODDY_STEP_INSTRUCTIONS__\nFooter",
      stepInstructionsPlaceholder: "__BOBODDY_STEP_INSTRUCTIONS__",
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

function createWorkerClient(
  executionMode: "workspace" | "no_workspace" = "workspace",
): StepExecutionWorkerClient {
  return {
    userId: requestedByUserId,
    claimStepExecutions: vi.fn(),
    heartbeatStepExecution: vi.fn(),
    failStepExecution: vi.fn(),
    completeStepExecution: vi.fn(),
    appendStepExecutionLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    getStepExecution: vi.fn(),
    getStepExecutionWorkerContext: vi.fn(() =>
      Promise.resolve(createWorkerContext(executionMode)),
    ),
    createArtifactUploadUrl: vi.fn(),
    recordArtifact: vi.fn(),
  };
}

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

function runClaim(deps: ProcessProjectWorkDeps) {
  return startProcessClaimedExecution(
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
