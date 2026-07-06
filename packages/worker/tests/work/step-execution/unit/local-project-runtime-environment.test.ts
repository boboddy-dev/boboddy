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
 * The two ordering invariants that matter most are asserted explicitly:
 *   1. The devcontainer.json mounts/appPort are patched BEFORE the container is
 *      launched (otherwise the runtime payload would never be mounted).
 *   2. OpenCode is started AFTER the container is up (in-container, one runtime).
 *
 * Fakes:
 *   - WorkspaceManager / GitCloneService: real temp workspace + a real cloned
 *     devcontainer.json so resolveDevcontainerWorkspaceFolder and the mount
 *     patch operate on real files.
 *   - DevcontainerLauncher: records launch; never touches Docker.
 *   - OpencodeRuntimePayloadProvisioner: subclassed; `ensure()` returns a fake
 *     payload location without downloading from the registry.
 *   - DevcontainerOpencodeBootstrap: subclassed; planMounts returns fixed mounts
 *     + a fixed host port, patchConfig writes the real devcontainer.json patch
 *     (so we can assert it ran before launch), start/stop/cleanup are stubbed
 *     so no `docker exec` runs.
 *   - Provider access: the real DirectProviderAccessResolver +
 *     SessionRuntimeConfigMaterializer driven by an explicit env override (no
 *     host credential discovery, no broad mounts).
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import { DirectProviderAccessResolver } from "../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "../../../../src/work/step-execution/infra/provider-access/session-runtime-config-materializer";
import { OpencodeRuntimePayloadProvisioner } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import {
  DevcontainerOpencodeBootstrap,
  CONTAINER_AGENT_HOME,
} from "../../../../src/runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import type {
  PlanMountsInput,
  PlanMountsResult,
  StartInput,
  StartResult,
} from "../../../../src/runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import type { OpencodeRuntimePayloadLocation } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import type {
  DevcontainerLauncher,
  LaunchDevcontainerInput,
  LaunchDevcontainerResult,
} from "../../../../src/runtime/runtime-service/application/devcontainer-launcher";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../../../../src/runtime/runtime-service/application/git-clone-service";
import type {
  ProvisionedWorkspace,
  WorkspaceManager,
} from "../../../../src/runtime/runtime-service/application/workspace-manager";
import {
  PROVIDER_ACCESS_ENV_VARS,
  type EnvSource,
} from "../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";

type PrepareAgentHomeConfigInput = Parameters<DevcontainerOpencodeBootstrap["prepareAgentHomeConfig"]>[0];
type PrepareAgentHomeConfigResult = Awaited<ReturnType<DevcontainerOpencodeBootstrap["prepareAgentHomeConfig"]>>;

const DEVCONTAINER_CONFIG_PATH = ".devcontainer/devcontainer.json";
const DEVCONTAINER_JSON = JSON.stringify(
  {
    name: "orchestrator-launch-test",
    image: "mcr.microsoft.com/devcontainers/base:debian",
  },
  null,
  2,
);

const FAKE_HOST_PORT = 54321;
const FAKE_DEVCONTAINER_ID = "fake-devcontainer-id";
const FAKE_PAYLOAD_VERSION = "1.17.3-test";

function envFrom(values: Record<string, string>): EnvSource {
  return (name) => values[name];
}

/** Records a global, ordered log of orchestration steps for sequence asserts. */
type CallLog = string[];

class FakeWorkspaceManager implements WorkspaceManager {
  removeCalls: string[] = [];
  constructor(
    private readonly workspacePath: string,
    private readonly log: CallLog,
  ) {}
  createWorkspace(): Promise<ProvisionedWorkspace> {
    this.log.push("createWorkspace");
    return Promise.resolve({ workspacePath: this.workspacePath });
  }
  removeWorkspace(workspacePath: string): Promise<void> {
    this.removeCalls.push(workspacePath);
    return Promise.resolve();
  }
}

/** Writes a real devcontainer.json into the workspace so later steps can read it. */
class FakeGitCloneService implements GitCloneService {
  constructor(private readonly log: CallLog) {}
  async cloneRepository(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    this.log.push("clone");
    const configDir = path.join(input.workspacePath, ".devcontainer");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "devcontainer.json"),
      DEVCONTAINER_JSON,
      "utf8",
    );
    return { resolvedBranch: input.requestedBranch ?? "main" };
  }
}

class FakeDevcontainerLauncher implements DevcontainerLauncher {
  launchInputs: LaunchDevcontainerInput[] = [];
  stopCalls: string[] = [];
  constructor(private readonly log: CallLog) {}
  resolveConfigPath(): Promise<string> {
    this.log.push("resolveConfigPath");
    return Promise.resolve(DEVCONTAINER_CONFIG_PATH);
  }
  launch(input: LaunchDevcontainerInput): Promise<LaunchDevcontainerResult> {
    this.log.push("launchDevcontainer");
    this.launchInputs.push(input);
    return Promise.resolve({ containerId: FAKE_DEVCONTAINER_ID });
  }
  stop(containerId: string): Promise<void> {
    this.stopCalls.push(containerId);
    return Promise.resolve();
  }
}

/**
 * Payload provisioner fake. `OpencodeRuntimePayloadProvisioner` carries private
 * fields (nominal type), so we subclass and override the single public method
 * instead of supplying a structural fake.
 */
class FakePayloadProvisioner extends OpencodeRuntimePayloadProvisioner {
  ensureCalls = 0;
  constructor(private readonly log: CallLog) {
    super();
  }
  override ensure(): Promise<OpencodeRuntimePayloadLocation> {
    this.ensureCalls += 1;
    this.log.push("ensurePayload");
    return Promise.resolve({
      version: FAKE_PAYLOAD_VERSION,
      hostPayloadDir: "/host/payload",
      containerPayloadDir: `/opt/boboddy/runtimes/opencode/${FAKE_PAYLOAD_VERSION}`,
      containerLaunchWrapperPath: `/opt/boboddy/runtimes/opencode/${FAKE_PAYLOAD_VERSION}/launch.sh`,
    });
  }
}

/**
 * Bootstrap fake. planMounts returns fixed mounts + host port; patchConfig
 * runs the REAL devcontainer.json patch (so we can assert it happened before
 * launch); start/stop/cleanup are stubbed so no `docker exec` runs.
 */
class FakeOpencodeBootstrap extends DevcontainerOpencodeBootstrap {
  planMountsCalls: PlanMountsInput[] = [];
  patchConfigInputs: { mounts: number; hostPort: number }[] = [];
  prepareAgentHomeConfigCalls: PrepareAgentHomeConfigInput[] = [];
  startInputs: StartInput[] = [];
  stopCalls: string[] = [];
  cleanupCalls: string[] = [];
  constructor(private readonly log: CallLog) {
    super();
  }
  override planMounts(input: PlanMountsInput): Promise<PlanMountsResult> {
    this.log.push("planMounts");
    this.planMountsCalls.push(input);
    return Promise.resolve({
      mounts: [
        {
          source: input.payload.hostPayloadDir,
          target: input.payload.containerPayloadDir,
          readOnly: true,
        },
        {
          source: input.sessionAgentHomeDir,
          target: CONTAINER_AGENT_HOME,
          readOnly: false,
        },
      ],
      hostPort: FAKE_HOST_PORT,
    });
  }
  override async patchConfig(input: {
    workspacePath: string;
    devcontainerConfigPath: string;
    mounts: readonly { source: string; target: string; readOnly?: boolean }[];
    hostPort: number;
  }): Promise<void> {
    this.log.push("patchMounts");
    this.patchConfigInputs.push({
      mounts: input.mounts.length,
      hostPort: input.hostPort,
    });
    // Write a real marker into the cloned devcontainer.json so the test can
    // confirm the patch ran against the on-disk config before launch.
    const configAbsPath = path.join(
      input.workspacePath,
      input.devcontainerConfigPath,
    );
    const raw = await readFile(configAbsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed["mounts"] = input.mounts.map((m) => `${m.source}->${m.target}`);
    parsed["appPort"] = [`127.0.0.1:${String(input.hostPort)}:4096`];
    await writeFile(configAbsPath, JSON.stringify(parsed, null, 2), "utf8");
  }
  override prepareAgentHomeConfig(
    input: PrepareAgentHomeConfigInput,
  ): Promise<PrepareAgentHomeConfigResult> {
    this.log.push("prepareAgentHomeConfig");
    this.prepareAgentHomeConfigCalls.push(input);
    return Promise.resolve({ hostConfigPath: null, hostAuthPath: null });
  }
  override start(input: StartInput): Promise<StartResult> {
    this.log.push("startOpencode");
    this.startInputs.push(input);
    return Promise.resolve({
      agentBaseUrl: `http://127.0.0.1:${String(input.hostPort)}`,
      agentLogDirectory: `${CONTAINER_AGENT_HOME}/.boboddy-log`,
    });
  }
  override stop(containerId: string): Promise<void> {
    this.stopCalls.push(containerId);
    return Promise.resolve();
  }
  override cleanupSessionHome(sessionAgentHomeDir: string): Promise<void> {
    this.cleanupCalls.push(sessionAgentHomeDir);
    return Promise.resolve();
  }
}

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
    const workspaceManager = new FakeWorkspaceManager(workspacePath, log);
    const gitCloneService = new FakeGitCloneService(log);
    const devcontainerLauncher = new FakeDevcontainerLauncher(log);
    const payloadProvisioner = new FakePayloadProvisioner(log);
    const opencodeBootstrap = new FakeOpencodeBootstrap(log);
    // Real resolver + materializer, driven by an explicit env override so the
    // run is configured purely via worker env (no host credential discovery).
    const providerEnv = envFrom({
      [PROVIDER_ACCESS_ENV_VARS.baseUrl]: "https://api.example.com",
      [PROVIDER_ACCESS_ENV_VARS.tokenEnv]: "BOBODDY_TEST_TOKEN",
      BOBODDY_TEST_TOKEN: "secret-token",
    });
    const providerAccessResolver = new DirectProviderAccessResolver({
      env: providerEnv,
      discover: () => Promise.resolve(undefined),
    });
    const runtimeConfigMaterializer = new SessionRuntimeConfigMaterializer({
      outputBaseDir: providerOutputDir,
      env: providerEnv,
    });
    return {
      workspaceManager,
      gitCloneService,
      devcontainerLauncher,
      payloadProvisioner,
      opencodeBootstrap,
      providerAccessResolver,
      runtimeConfigMaterializer,
    };
  }

  function launchInput() {
    return {
      sessionId: createUuidV7(),
      projectId: createUuidV7(),
      requestedByUserId: createUuidV7(),
      gitUrl: "https://example.com/repo.git",
      requestedBranch: "main",
      currentExecutionInfo: {
        stepExecutionId: createUuidV7(),
        resultSchemaJson: null,
      },
    };
  }

  test("runs the launch steps in order: clone → patch → launch → start", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    await orchestrator.launch(launchInput());

    // The exact, observable sequence the single-container model depends on.
    expect(log).toEqual([
      "createWorkspace",
      "clone",
      "resolveConfigPath",
      "ensurePayload",
      "planMounts",
      "patchMounts",
      "prepareAgentHomeConfig",
      "launchDevcontainer",
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

    await orchestrator.launch(launchInput());

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

    await orchestrator.launch(launchInput());

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

  test("prepareAgentHomeConfig is called AFTER planMounts but BEFORE launchDevcontainer", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    await orchestrator.launch(launchInput());

    const planIndex = log.indexOf("planMounts");
    const prepareIndex = log.indexOf("prepareAgentHomeConfig");
    const launchIndex = log.indexOf("launchDevcontainer");
    expect(prepareIndex).toBeGreaterThan(planIndex);
    expect(launchIndex).toBeGreaterThan(prepareIndex);
    expect(deps.opencodeBootstrap.prepareAgentHomeConfigCalls).toHaveLength(1);
  });

  test("returns a single-runtime environment (devcontainer id, agent base url, payload version, no network)", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    const env = await orchestrator.launch(launchInput());

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

  test("cleanup tears down the single runtime: stops OpenCode, removes the session HOME, stops the container, removes the workspace", async () => {
    const log: CallLog = [];
    const deps = buildDeps(log);
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );

    const env = await orchestrator.launch(launchInput());
    await env.cleanup();

    expect(deps.opencodeBootstrap.stopCalls).toEqual([FAKE_DEVCONTAINER_ID]);
    expect(deps.opencodeBootstrap.cleanupCalls).toHaveLength(1);
    expect(deps.devcontainerLauncher.stopCalls).toEqual([FAKE_DEVCONTAINER_ID]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });

  test("on a launch failure during OpenCode start, it cleans up the partial runtime (stops the container, removes the session HOME + workspace)", async () => {
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
      await orchestrator.launch(launchInput());
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
    // process), remove the session HOME, and remove the workspace.
    expect(failingBootstrap.stopCalls).toEqual([]);
    expect(failingBootstrap.cleanupCalls).toHaveLength(1);
    expect(deps.devcontainerLauncher.stopCalls).toEqual([FAKE_DEVCONTAINER_ID]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });
});
