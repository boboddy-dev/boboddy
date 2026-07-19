/**
 * Unit test for the SINGLE-CONTAINER launch orchestrator
 * ({@link DefaultLocalProjectRuntimeEnvironmentOrchestrator}).
 *
 * This is the one place the whole launch SEQUENCE is asserted end-to-end with
 * fakes — no real Docker, devcontainer CLI, npm payload download, or
 * `docker exec`. It verifies the wiring and ordering the migration's Phase 4
 * rewrite established:
 *
 *   clone → write current-execution metadata → resolve devcontainer config +
 *   workspace folder → patch env → provision payload → resolve + materialize
 *   provider access → plan mounts → patch devcontainer.json with mounts/appPort
 *   → launch devcontainer → build opencode context → start OpenCode INSIDE the
 *   container → return a single-runtime environment.
 *
 * The branch-per-step behavior is covered in
 * `local-project-runtime-environment-branch.test.ts`; the shared fakes live in
 * `helpers/orchestrator-launch-fakes.ts`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import type {
  StartInput,
  StartResult,
} from "../../../../src/runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  DEVCONTAINER_CONFIG_PATH,
  FAKE_DEVCONTAINER_ID,
  FAKE_HOST_PORT,
  FAKE_PAYLOAD_VERSION,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

describe("DefaultLocalProjectRuntimeEnvironmentOrchestrator.launch (single-container)", () => {
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

  test("runs the launch steps in order: clone → patch → launch → start", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    await orchestrator.launch(buildLaunchInput());

    // The exact, observable sequence the single-container model depends on.
    expect(log).toEqual([
      "createWorkspace",
      "clone",
      "resolveConfigPath",
      "ensurePayload",
      "planMounts",
      "patchMounts",
      "launchDevcontainer",
      "prepareAgentHome",
      "startOpencode",
    ]);
  });

  test("patches the devcontainer mounts/appPort BEFORE launching the container", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    await orchestrator.launch(buildLaunchInput());

    const patchIndex = log.indexOf("patchMounts");
    const launchIndex = log.indexOf("launchDevcontainer");
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(launchIndex).toBeGreaterThan(patchIndex);

    // The patch ran against the real on-disk config: mounts + appPort are now
    // present so the runtime payload would actually be mounted at launch.
    const configRaw = await readFile(
      path.join(workspacePath, DEVCONTAINER_CONFIG_PATH),
      "utf8",
    );
    const config = JSON.parse(configRaw) as {
      mounts?: string[];
      appPort?: string[];
    };
    expect(config.mounts).toBeDefined();
    expect(config.mounts?.length).toBeGreaterThan(0);
    expect(config.appPort).toEqual([`127.0.0.1:${String(FAKE_HOST_PORT)}:4096`]);
  });

  test("starts OpenCode in-container after the devcontainer is up, with the materialized provider env and Boboddy override config", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    await orchestrator.launch(buildLaunchInput());

    expect(deps.opencodeBootstrap.startInputs).toHaveLength(1);
    const start = deps.opencodeBootstrap.startInputs[0];
    // Start targets the SAME container the launcher returned (single runtime).
    expect(start?.containerId).toBe(FAKE_DEVCONTAINER_ID);
    expect(start?.hostPort).toBe(FAKE_HOST_PORT);
    // Launched by the mounted payload's absolute wrapper path.
    expect(start?.launchWrapperPath).toBe(
      `/opt/boboddy/runtimes/opencode/${FAKE_PAYLOAD_VERSION}/launch.sh`,
    );
    // Provider env was materialized from the explicit worker env override and
    // handed to OpenCode at launch (token under its tokenEnv name + base URL).
    expect(start?.providerEnv["BOBODDY_TEST_TOKEN"]).toBe("secret-token");
    expect(start?.providerEnv["BOBODDY_PROVIDER_BASE_URL"]).toBe(
      "https://api.example.com",
    );
    // Boboddy's override config is passed as OPENCODE_CONFIG_CONTENT (valid JSON).
    expect(start?.opencodeConfigContent).toBeDefined();
    expect(() => { JSON.parse(start?.opencodeConfigContent ?? ""); }).not.toThrow();
  });

  test("prepareAgentHome is called AFTER launchDevcontainer but BEFORE startOpencode", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    await orchestrator.launch(buildLaunchInput());

    // The agent HOME lives on the container's overlay fs, so seeding must
    // happen against the ALREADY-RUNNING container and before OpenCode serve.
    const launchIndex = log.indexOf("launchDevcontainer");
    const prepareIndex = log.indexOf("prepareAgentHome");
    const startIndex = log.indexOf("startOpencode");
    expect(prepareIndex).toBeGreaterThan(launchIndex);
    expect(startIndex).toBeGreaterThan(prepareIndex);
    expect(deps.opencodeBootstrap.prepareAgentHomeCalls).toHaveLength(1);
  });

  test("returns a single-runtime environment (devcontainer id, agent base url, payload version, no network)", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    const env = await orchestrator.launch(buildLaunchInput());

    expect(env.runtimeContainerId).toBe(FAKE_DEVCONTAINER_ID);
    expect(env.agentBaseUrl).toBe(`http://127.0.0.1:${String(FAKE_HOST_PORT)}`);
    // No AI image is pulled; the field surfaces the pinned runtime version.
    expect(env.aiImage).toBe(`opencode-runtime@${FAKE_PAYLOAD_VERSION}`);
    // No session network in the single-container model.
    expect(env.networkName).toBe("");
    // The agent-facing workspace folder defaults to /workspaces/<basename>
    // when the devcontainer omits an explicit workspaceFolder.
    expect(env.workspaceFolder).toBe(
      `/workspaces/${path.basename(workspacePath)}`,
    );
    expect(env.devcontainerConfigPath).toBe(DEVCONTAINER_CONFIG_PATH);
    // The materialized provider env values (Path B secrets) are surfaced so the
    // caller can register them with the log masker; the token is included.
    expect(env.secretValues).toContain("secret-token");
  });

  test("cleanup tears down the single runtime: stops OpenCode, stops the container, removes the workspace (no host-dir removal — overlay HOME dies with the container)", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    const env = await orchestrator.launch(buildLaunchInput());
    await env.cleanup();

    expect(deps.opencodeBootstrap.stopCalls).toEqual([FAKE_DEVCONTAINER_ID]);
    // The agent HOME is on the container's overlay fs and dies with the
    // container, so the orchestrator performs no host agent-HOME removal.
    expect(deps.opencodeBootstrap.cleanupCalls).toHaveLength(0);
    expect(deps.devcontainerLauncher.stopCalls).toEqual([FAKE_DEVCONTAINER_ID]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });

  test("on a launch failure during OpenCode start, it cleans up the partial runtime (stops the container + removes the workspace; no host-dir removal — overlay HOME dies with the container)", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    // Make start fail AFTER the container launched + OpenCode start was reached.
    const failingBootstrap = deps.opencodeBootstrap;
    failingBootstrap.start = (input: StartInput): Promise<StartResult> => {
      log.push("startOpencode");
      failingBootstrap.startInputs.push(input);
      return Promise.reject(new Error("opencode failed to become healthy"));
    };
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    let caught: unknown;
    try {
      await orchestrator.launch(buildLaunchInput());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /opencode failed to become healthy/,
    );

    // start() rejected before `opencodeStarted` flipped, so the orchestrator
    // does not separately call opencodeBootstrap.stop — but it MUST still
    // tear down the launched container (which terminates any in-container
    // process) and remove the workspace. The agent HOME is on overlay and dies
    // with the container, so there is no host agent-HOME removal.
    expect(failingBootstrap.stopCalls).toEqual([]);
    expect(failingBootstrap.cleanupCalls).toHaveLength(0);
    expect(deps.devcontainerLauncher.stopCalls).toEqual([FAKE_DEVCONTAINER_ID]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });
});
