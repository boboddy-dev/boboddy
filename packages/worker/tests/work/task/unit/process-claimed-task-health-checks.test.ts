import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { HealthCheck, ToolHealthCheck } from "@boboddy/sdk/health-checks";
import { startProcessClaimedTask } from "../../../../src/work/task/application/process-claimed-task";
import { HealthCheckFailedError } from "../../../../src/work/task/application/health-check-failed-error";
import type { HealthCheckReport } from "../../../../src/work/task/application/run-health-checks";
import type { ProcessProjectWorkDeps } from "../../../../src/work/task/contracts/process-project-work-types";
import {
  noopReporter,
  type WorkEvent,
} from "../../../../src/work/task/contracts/work-reporter";
import type { FakeAiServer } from "../../../../src/work/task/infra/fake-ai/fake-ai-server";
import {
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  projectId,
  requestedByUserId,
  runClaim,
  taskId,
} from "./helpers/claimed-task-fixtures";

/**
 * #120: health checks run immediately after `runtime-ready` and before the
 * agent is prompted. `runHealthChecks` and `createFakeAiServer` are injected
 * here the same way `agentRunner` already is in
 * `process-claimed-task.test.ts` — the real forced-tool-call
 * machinery (#119) has its own dedicated unit/integration coverage in
 * `run-health-checks.test.ts`.
 */
describe("startProcessClaimedTask declared health checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Returns the fake server plus its raw `start`/`stop` mocks separately, so
   * assertions reference the mocks directly instead of `fakeAiServer.start`
   * (which trips `@typescript-eslint/unbound-method` when read off the typed
   * class instance).
   */
  function createFakeAiServerStub(port = 9999) {
    const start = vi.fn(() => Promise.resolve(undefined));
    const stop = vi.fn(() => Promise.resolve(undefined));
    const fakeAiServer = { start, stop, port } as unknown as FakeAiServer;
    return { fakeAiServer, start, stop };
  }

  function healthCheck(overrides: Partial<ToolHealthCheck> = {}): HealthCheck {
    return {
      kind: "tool",
      tool: "greet",
      severity: "required",
      timeoutSeconds: 15,
      ...overrides,
    };
  }

  function healthCheckReport(
    overrides: Partial<HealthCheckReport> = {},
  ): HealthCheckReport {
    return {
      name: "greet",
      resolvedId: "greet",
      severity: "required",
      kind: "tool",
      outcome: { kind: "passed" },
      ...overrides,
    };
  }

  function createLaunchMock(input: {
    workspacePath: string;
    cleanup: () => Promise<void>;
  }) {
    // Accepts (and records) the launch call's argument object — needed so
    // `launch.mock.calls[0]?.[0]` below is typed, rather than `[]`.
    return vi.fn(
      (launchInput: {
        fakeAiProviderOverride?: { baseUrl: string } | undefined;
      }) => {
        void launchInput;
        return Promise.resolve({
          workspacePath: input.workspacePath,
          workspaceFolder: "/workspaces/repo",
          resolvedBranch: "main",
          workBranch: null,
          createdFromBranch: null,
          devcontainerConfigPath: "",
          runtimeContainerId: null,
          agent: {
            baseUrl: "http://localhost:4096",
            password: "test-password",
            version: "0.0.0-test",
            logDirectory: path.join(input.workspacePath, ".logs"),
          },
          aiImage: "opencode-runtime@test",
          networkName: "",
          secretValues: [],
          cleanup: input.cleanup,
        });
      },
    );
  }

  function createEventRecordingReporter(events: WorkEvent[]) {
    return {
      ...noopReporter,
      event: (event: WorkEvent) => {
        events.push(event);
      },
    };
  }

  test("a step declaring no health checks starts no fake-AI harness, registers no synthetic provider, and launches unchanged", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-health-checks-none-"),
    );
    const launch = createLaunchMock({
      workspacePath,
      cleanup: () => Promise.resolve(),
    });
    const workerClient = createWorkerClient();
    const createFakeAiServerMock = vi.fn(
      () => createFakeAiServerStub().fakeAiServer,
    );
    const runHealthChecksMock = vi.fn(() => Promise.resolve([]));
    const events: WorkEvent[] = [];

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
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      reporter: createEventRecordingReporter(events),
      createFakeAiServer: createFakeAiServerMock,
      runHealthChecks: runHealthChecksMock,
    } satisfies ProcessProjectWorkDeps;

    await runClaim(deps);

    expect(createFakeAiServerMock).not.toHaveBeenCalled();
    expect(runHealthChecksMock).not.toHaveBeenCalled();
    expect(launch.mock.calls[0]?.[0]?.fakeAiProviderOverride).toBeUndefined();
    expect(
      events.some((event) => event.type === "task:health-checks-running"),
    ).toBe(false);
    expect(deps.agentRunner.promptAsync).toHaveBeenCalledTimes(1);
  });

  test("passing health checks let the step proceed to the agent exactly as before", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-health-checks-pass-"),
    );
    const cleanup = vi.fn(() => Promise.resolve(undefined));
    const launch = createLaunchMock({ workspacePath, cleanup });
    const workerClient = createWorkerClient();
    workerClient.getTaskWorkerContext = vi.fn(() =>
      Promise.resolve(createWorkerContext("workspace", [healthCheck()])),
    );
    const { fakeAiServer, start, stop } = createFakeAiServerStub();
    const createFakeAiServerMock = vi.fn(() => fakeAiServer);
    const runHealthChecksMock = vi.fn(() =>
      Promise.resolve([healthCheckReport()]),
    );
    const events: WorkEvent[] = [];

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
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      reporter: createEventRecordingReporter(events),
      createFakeAiServer: createFakeAiServerMock,
      runHealthChecks: runHealthChecksMock,
    } satisfies ProcessProjectWorkDeps;

    await runClaim(deps);

    expect(createFakeAiServerMock).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    // Stopped immediately after checks complete, before the agent is prompted.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runHealthChecksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        server: {
          baseUrl: "http://localhost:4096",
          password: "test-password",
          workspaceFolder: "/workspaces/repo",
        },
        healthChecks: [healthCheck()],
        fakeAiServer,
      }),
    );
    expect(
      launch.mock.calls[0]?.[0]?.fakeAiProviderOverride?.baseUrl,
    ).toContain(":9999");
    expect(deps.agentRunner.promptAsync).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();

    const runtimeReadyIndex = events.findIndex(
      (event) => event.type === "task:runtime-ready",
    );
    const healthChecksIndex = events.findIndex(
      (event) => event.type === "task:health-checks-running",
    );
    const agentRunningIndex = events.findIndex(
      (event) => event.type === "task:agent-running",
    );
    expect(runtimeReadyIndex).toBeGreaterThanOrEqual(0);
    expect(healthChecksIndex).toBeGreaterThan(runtimeReadyIndex);
    expect(agentRunningIndex).toBeGreaterThan(healthChecksIndex);
  });

  test("a failing required health check throws before the agent is prompted, cleans up, and marks the run failed", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-health-checks-fail-"),
    );
    const cleanup = vi.fn(() => Promise.resolve(undefined));
    const launch = createLaunchMock({ workspacePath, cleanup });
    const workerClient = createWorkerClient();
    workerClient.getTaskWorkerContext = vi.fn(() =>
      Promise.resolve(createWorkerContext("workspace", [healthCheck()])),
    );
    const { fakeAiServer, stop } = createFakeAiServerStub();
    const createFakeAiServerMock = vi.fn(() => fakeAiServer);
    const runHealthChecksMock = vi.fn(() =>
      Promise.resolve([
        healthCheckReport({
          outcome: {
            kind: "failed",
            reason: "tool-error",
            detail: "the MCP tool call errored",
          },
        }),
      ]),
    );
    const events: WorkEvent[] = [];
    // Read directly instead of via `runTracker.markFailed` below — the latter
    // trips `@typescript-eslint/unbound-method` when read off the
    // interface-typed tracker.
    const markFailed = vi.fn(() => Promise.resolve(undefined));
    const runTracker = { ...createRunTracker(), markFailed };

    const deps = {
      workerClient,
      createRunTracker: () => runTracker,
      runtimeEnvironmentOrchestrator: { launch },
      agentRunner: {
        promptAsync: vi.fn(() =>
          Promise.resolve({ sessionId: "agent-session-id" }),
        ),
        getSessionStatus: vi.fn(),
        sendRetryPrompt: vi.fn(),
      },
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      reporter: createEventRecordingReporter(events),
      createFakeAiServer: createFakeAiServerMock,
      runHealthChecks: runHealthChecksMock,
    } satisfies ProcessProjectWorkDeps;

    let caught: unknown;
    try {
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
        runTracker,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HealthCheckFailedError);
    expect((caught as Error).message).toContain("the MCP tool call errored");
    expect(deps.agentRunner.promptAsync).not.toHaveBeenCalled();
    // Stopped as soon as the checks finish, regardless of outcome.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "task:failed")).toBe(true);
  });

  test("with preserveRuntimeOnFailure (-k), a failing required health check leaves the runtime in place", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-health-checks-keep-"),
    );
    const cleanup = vi.fn(() => Promise.resolve(undefined));
    const launch = createLaunchMock({ workspacePath, cleanup });
    const workerClient = createWorkerClient();
    workerClient.getTaskWorkerContext = vi.fn(() =>
      Promise.resolve(createWorkerContext("workspace", [healthCheck()])),
    );
    const { fakeAiServer } = createFakeAiServerStub();
    const runHealthChecksMock = vi.fn(() =>
      Promise.resolve([
        healthCheckReport({
          outcome: { kind: "failed", reason: "tool-error", detail: "boom" },
        }),
      ]),
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
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      reporter: noopReporter,
      createFakeAiServer: vi.fn(() => fakeAiServer),
      runHealthChecks: runHealthChecksMock,
    } satisfies ProcessProjectWorkDeps;

    let caught: unknown;
    try {
      await startProcessClaimedTask(
        {
          projectId,
          requestedByUserId,
          claim: {
            task: { id: taskId },
            claimToken: "claim-token",
          },
          leaseDurationSeconds: 30,
          preserveRuntimeOnFailure: true,
        },
        deps,
        deps.workerClient,
        createRunTracker(),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HealthCheckFailedError);
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("stops the fake-AI harness from the failure path when the runtime launch itself throws", async () => {
    // The harness is started (to compute `fakeAiProviderOverride`) BEFORE the
    // runtime launch call it feeds into — so a launch failure leaves the
    // harness running and never reaches the gate's own stop-in-`finally`.
    // The outer `catch` block's stop-if-still-set fallback must cover this.
    const workerClient = createWorkerClient();
    workerClient.getTaskWorkerContext = vi.fn(() =>
      Promise.resolve(createWorkerContext("workspace", [healthCheck()])),
    );
    const { fakeAiServer, stop } = createFakeAiServerStub();
    const createFakeAiServerMock = vi.fn(() => fakeAiServer);
    const runHealthChecksMock = vi.fn(() => Promise.resolve([]));
    const launch = vi.fn(() =>
      Promise.reject(new Error("devcontainer failed to start")),
    );
    const events: WorkEvent[] = [];

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
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      reporter: createEventRecordingReporter(events),
      createFakeAiServer: createFakeAiServerMock,
      runHealthChecks: runHealthChecksMock,
    } satisfies ProcessProjectWorkDeps;

    let caught: unknown;
    try {
      await runClaim(deps);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toBe("devcontainer failed to start");
    expect(runHealthChecksMock).not.toHaveBeenCalled();
    expect(deps.agentRunner.promptAsync).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
