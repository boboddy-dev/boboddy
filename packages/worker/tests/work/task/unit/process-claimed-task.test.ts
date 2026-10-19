import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "bun:test";
import type { RepoConfig } from "@boboddy/sdk/repo-config";
import { startProcessClaimedTask } from "../../../../src/work/task/application/process-claimed-task";
import type { ProcessProjectWorkDeps } from "../../../../src/work/task/contracts/process-project-work-types";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  projectId,
  requestedByUserId,
  runClaim,
  taskId,
} from "./helpers/claimed-task-fixtures";
import {
  disposeMirrorFixtureTemplate,
  shipLaunchGitTimingLines,
} from "./helpers/launch-git-timing-fixture";

afterAll(disposeMirrorFixtureTemplate);

describe("startProcessClaimedTask", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["BASE_URL"];
  });

  test("passes the server-handed baseWorkBranch to the runtime launch", async () => {
    process.env["BASE_URL"] = "https://app.example.com";

    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-claimed-step-"),
    );
    const { launch } = createRecordingOrchestrator(workspacePath, {
      resolvedBranch: "main",
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      aiImage: "boboddy/ai-worker:local",
      networkName: "test-network",
    });

    const workerClient = createWorkerClient();
    workerClient.getTaskWorkerContext = vi.fn(() =>
      Promise.resolve({
        ...createWorkerContext(),
        baseWorkBranch: "boboddy/prev-step",
      }),
    );

    const promptAsync = vi.fn(() =>
      Promise.resolve({ sessionId: "agent-session-id" }),
    );
    const deps = createRoutingDeps({
      workerClient,
      workspaceOrchestrator: { launch },
    });
    deps.agentRunner.promptAsync = promptAsync;

    await runClaim(deps);

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        baseWorkBranch: "boboddy/prev-step",
      }),
    );
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        server: {
          baseUrl: "http://localhost:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
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
    const { launch } = createRecordingOrchestrator(workspacePath, {
      resolvedBranch: "main",
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      aiImage: "boboddy/ai-worker:local",
      networkName: "test-network",
    });

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
      ...createRoutingDeps({
        workerClient: createWorkerClient(),
        workspaceOrchestrator: { launch },
      }),
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
    } satisfies ProcessProjectWorkDeps;

    await startProcessClaimedTask(
      {
        projectId,
        requestedByUserId,
        claim: {
          task: { id: taskId },
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
      server: {
        baseUrl: "http://localhost:4096",
        password: "test-password",
        workspaceFolder: "/workspaces/repo",
      },
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
 * `startProcessClaimedTask` seam by varying the worker context's
 * `stepDefinition.executionMode` and asserting which orchestrator's `launch`
 * ran (matching the existing test's fake-deps style).
 */
describe("startProcessClaimedTask runtime orchestrator routing", () => {
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

  test.each<["agent"]>([["agent"]])(
    "launches the agent for an '%s' task",
    async (kind) => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-routing-start-agent-"),
      );
      const workspaceOrchestrator = createRecordingOrchestrator(workspacePath);
      const workerClient = createWorkerClient("workspace");
      workerClient.getTaskWorkerContext = vi.fn(() =>
        Promise.resolve(createWorkerContext("workspace", null, { kind })),
      );
      const deps = createRoutingDeps({ workerClient, workspaceOrchestrator });

      await runClaim(deps);

      expect(workspaceOrchestrator.launch).toHaveBeenCalledWith(
        expect.objectContaining({ startAgent: true }),
      );
    },
  );

  test.each([[".devcontainer/alt/devcontainer.json"], [null]])(
    "passes the step's devcontainerConfigPath (%p) to the workspace launch",
    async (devcontainerConfigPath) => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-routing-config-"),
      );
      const workspaceOrchestrator = createRecordingOrchestrator(workspacePath);
      const workerClient = createWorkerClient("workspace");
      workerClient.getTaskWorkerContext = vi.fn(() =>
        Promise.resolve(
          createWorkerContext("workspace", null, { devcontainerConfigPath }),
        ),
      );
      const deps = createRoutingDeps({ workerClient, workspaceOrchestrator });

      await runClaim(deps);

      expect(workspaceOrchestrator.launch).toHaveBeenCalledWith(
        expect.objectContaining({ devcontainerConfigPath }),
      );
    },
  );

  test.each<[RepoConfig, "workspace" | "no_workspace"]>([
    [{ mode: "readOnly" }, "workspace"],
    [{ mode: "readWrite", message: null, onPushFailure: "fail" }, "workspace"],
    [
      {
        mode: "readWrite",
        message: "fix: {{result.summary}}",
        onPushFailure: "warn",
      },
      "workspace",
    ],
    [{ mode: "none" }, "no_workspace"],
  ])(
    "hands the step's resolved repo (%p) to the %s launch unchanged, with the step input",
    async (repo, executionMode) => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-routing-repo-"),
      );
      const orchestrator = createRecordingOrchestrator(workspacePath);
      const unusedOrchestrator = createRecordingOrchestrator(workspacePath);
      const workerClient = createWorkerClient(executionMode);
      workerClient.getTaskWorkerContext = vi.fn(() =>
        Promise.resolve(createWorkerContext(executionMode, null, { repo })),
      );
      const deps =
        executionMode === "workspace"
          ? createRoutingDeps({
              workerClient,
              workspaceOrchestrator: orchestrator,
            })
          : createRoutingDeps({
              workerClient,
              workspaceOrchestrator: unusedOrchestrator,
              noWorkspaceOrchestrator: orchestrator,
            });

      await runClaim(deps);

      expect(orchestrator.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          repo,
          stepInputJson: { title: "Checkout bug" },
        }),
      );
    },
  );
});

describe("startProcessClaimedTask step env", () => {
  test("fails before launch, naming every missing required variable and no values", async () => {
    const workspaceOrchestrator = createRecordingOrchestrator(
      await mkdtemp(path.join(os.tmpdir(), "boboddy-claimed-step-env-")),
    );
    const workerClient = createWorkerClient();
    workerClient.getTaskWorkerContext = vi.fn(() =>
      Promise.resolve(
        createWorkerContext("workspace", null, {
          envJson: [
            {
              name: "WAREHOUSE_TOKEN",
              source: "inherit",
              from: "WAREHOUSE_TOKEN",
              secret: true,
              optional: false,
              applies: "agent",
            },
            {
              name: "DB_PASSWORD",
              source: "inherit",
              from: "STAGING_DB_PASSWORD",
              secret: true,
              optional: false,
              applies: "agent",
            },
          ],
        }),
      ),
    );
    const promptAsync = vi.fn();
    const deps = createRoutingDeps({ workerClient, workspaceOrchestrator });
    deps.agentRunner.promptAsync = promptAsync;
    const tracker = createRunTracker();

    let caught: unknown;
    try {
      await runClaim(deps, {
        tracker,
        workerEnv: { UNRELATED: "should-not-appear-anywhere" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("WAREHOUSE_TOKEN");
    expect(message).toContain("STAGING_DB_PASSWORD");
    expect(message).not.toContain("should-not-appear-anywhere");
    expect(workspaceOrchestrator.launch).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading through a plain object, not a class instance
    expect(tracker.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: message }),
    );
    expect(promptAsync).not.toHaveBeenCalled();
  });
});

describe("launchRuntimeEnvironment git timing lines reach the shipper", () => {
  test("ships mirror, local clone, overall clone and work-branch timings at info level before completion", async () => {
    const { shipped, baseEntries, completeCalls } =
      await shipLaunchGitTimingLines();

    expect(completeCalls).toBe(0);
    const worker = shipped.filter((line) => line.stream === "worker");
    const content = worker.map((line) => line.content);
    const gitCacheLines = content.filter((line) =>
      line.startsWith("[git-cache] "),
    );
    expect(gitCacheLines).toHaveLength(2);
    expect(gitCacheLines[0]).toMatch(
      /^\[git-cache\] git-cache: mirror created in \d+\.\ds \(miss\)$/u,
    );
    expect(gitCacheLines[1]).toMatch(
      /^\[git-cache\] git-cache: local clone in \d+\.\ds$/u,
    );
    expect(
      content.filter((line) =>
        /^\[runtime\] repository cloned in /u.test(line),
      ),
    ).toHaveLength(1);
    expect(
      content.filter((line) =>
        /^\[runtime\] work branch prepared in \d+\.\ds$/u.test(line),
      ),
    ).toHaveLength(1);
    const timingLines = worker.filter(
      (line) =>
        line.content.startsWith("[git-cache] ") ||
        /^\[runtime\] (repository cloned|work branch prepared)/u.test(
          line.content,
        ),
    );
    expect(timingLines).toHaveLength(4);
    expect(timingLines.every((line) => line.level === "info")).toBe(true);
    expect(baseEntries.some((entry) => entry.level === "debug")).toBe(false);
  });
});
