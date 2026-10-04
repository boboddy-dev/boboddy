/**
 * `startAgent: false` launch (code steps): the devcontainer is launched with
 * the clone, branches and `.boboddy/.env` patch, but none of the OpenCode work
 * runs — no payload, provider access, mount planning/patching, agent HOME
 * seeding, or `opencode serve` start/stop.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  DEVCONTAINER_CONFIG_PATH,
  FAKE_DEVCONTAINER_ID,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

describe("DefaultLocalProjectRuntimeEnvironmentOrchestrator.launch (startAgent: false)", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "orchestrator-provider-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function buildDeps(log: CallLog) {
    return buildOrchestratorFakeDeps({ workspacePath, providerOutputDir, log });
  }

  test("launches the devcontainer without any OpenCode work", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      startAgent: false,
    });

    expect(log).toEqual([
      "createWorkspace",
      "clone",
      "resolveConfigPath",
      "launchDevcontainer",
    ]);
    expect(deps.payloadProvisioner.ensureCalls).toBe(0);
    expect(deps.opencodeBootstrap.planMountsCalls).toHaveLength(0);
    expect(deps.opencodeBootstrap.patchConfigInputs).toHaveLength(0);
    expect(deps.opencodeBootstrap.prepareAgentHomeCalls).toHaveLength(0);
    expect(deps.opencodeBootstrap.startInputs).toHaveLength(0);

    expect(env.agent).toBeNull();
    expect(env.runtimeContainerId).toBe(FAKE_DEVCONTAINER_ID);
    expect(env.secretValues).toEqual([]);
  });

  test("leaves the devcontainer config free of the OpenCode mount and port, but still applies the .boboddy/.env patch", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      { MY_VAR: "my-value" },
      deps,
    );

    await orchestrator.launch({ ...buildLaunchInput(), startAgent: false });

    const config = JSON.parse(
      await readFile(
        path.join(workspacePath, DEVCONTAINER_CONFIG_PATH),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(config["mounts"]).toBeUndefined();
    expect(config["appPort"]).toBeUndefined();
    expect(config["runArgs"]).toBeUndefined();
    expect(config["containerEnv"]).toEqual({ MY_VAR: "my-value" });
  });

  test("cleanup tears down the container and workspace without stopping OpenCode", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      startAgent: false,
    });
    await env.cleanup();

    expect(deps.opencodeBootstrap.stopCalls).toEqual([]);
    expect(deps.devcontainerLauncher.stopCalls).toEqual([FAKE_DEVCONTAINER_ID]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });

  test("a devcontainer launch failure cleans up without stopping OpenCode", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    deps.devcontainerLauncher.launch = () =>
      Promise.reject(new Error("devcontainer up failed"));
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    let caught: unknown;
    try {
      await orchestrator.launch({ ...buildLaunchInput(), startAgent: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/devcontainer up failed/);

    expect(deps.opencodeBootstrap.stopCalls).toEqual([]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });
});
