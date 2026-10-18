import { describe, expect, test } from "bun:test";
import {
  runInDryRunEnvironment,
  type DryRunEnvironmentHealth,
  type DryRunLaunchInput,
} from "../../../../src/work/task/application/dry-run-environment";
import type {
  TaskRuntimeEnvironment,
  TaskRuntimeEnvironmentOrchestrator,
} from "../../../../src/work/task/contracts/process-project-work-types";

/**
 * The one launch seam every dry run goes through. What matters is that the
 * environment is torn down on every path — a container left behind by a
 * health-check gate is a leak the user never sees.
 */

const HEALTHY: DryRunEnvironmentHealth = {
  containerHealth: null,
  opencodeHealth: { healthy: true },
  mcpServers: [],
};

function fakeOrchestrator(
  options: { launchError?: string; noAgent?: boolean } = {},
) {
  const state = { cleanups: 0 };
  const environment = {
    workspacePath: "/tmp/ws",
    workspaceFolder: "/workspace",
    runtimeContainerId: "container-1",
    agent: options.noAgent
      ? null
      : { baseUrl: "http://127.0.0.1:1", password: "pw", version: "2.0.0" },
    cleanup: () => {
      state.cleanups += 1;
      return Promise.resolve();
    },
  } as unknown as TaskRuntimeEnvironment;
  const orchestrator: TaskRuntimeEnvironmentOrchestrator = {
    launch: () =>
      options.launchError
        ? Promise.reject(new Error(options.launchError))
        : Promise.resolve(environment),
  };
  return { orchestrator, state };
}

const launchInput = {} as DryRunLaunchInput;
const probe = () => Promise.resolve(HEALTHY);

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected a rejection, but the promise resolved.");
}

describe("runInDryRunEnvironment", () => {
  test("runs, reports, and tears down", async () => {
    const { orchestrator, state } = fakeOrchestrator();
    const outcome = await runInDryRunEnvironment({
      orchestrator,
      launchInput,
      keep: false,
      probe,
      run: (server) => Promise.resolve(server.workspaceFolder),
    });
    expect(outcome).toMatchObject({
      kind: "ran",
      result: "/workspace",
      kept: false,
    });
    expect(state.cleanups).toBe(1);
  });

  test("a launch failure is an outcome, not a throw, and there is nothing to tear down", async () => {
    const { orchestrator, state } = fakeOrchestrator({
      launchError: "no docker",
    });
    const outcome = await runInDryRunEnvironment({
      orchestrator,
      launchInput,
      keep: false,
      probe,
      run: () => Promise.resolve(null),
    });
    expect(outcome).toEqual({ kind: "launch-failed", reason: "no docker" });
    expect(state.cleanups).toBe(0);
  });

  test("tears down even when the run throws", async () => {
    const { orchestrator, state } = fakeOrchestrator();
    const message = await rejectionMessage(
      runInDryRunEnvironment({
        orchestrator,
        launchInput,
        keep: false,
        probe,
        run: () => Promise.reject(new Error("runner crashed")),
      }),
    );
    expect(message).toContain("runner crashed");
    expect(state.cleanups).toBe(1);
  });

  test("tears down when the launch came up without an agent", async () => {
    const { orchestrator, state } = fakeOrchestrator({ noAgent: true });
    const message = await rejectionMessage(
      runInDryRunEnvironment({
        orchestrator,
        launchInput,
        keep: false,
        probe,
        run: () => Promise.resolve(null),
      }),
    );
    expect(message).toContain("without an agent");
    expect(state.cleanups).toBe(1);
  });

  test("keep preserves the environment", async () => {
    const { orchestrator, state } = fakeOrchestrator();
    const outcome = await runInDryRunEnvironment({
      orchestrator,
      launchInput,
      keep: true,
      probe,
      run: () => Promise.resolve(null),
    });
    expect(outcome).toMatchObject({ kind: "ran", kept: true });
    expect(state.cleanups).toBe(0);
  });
});
