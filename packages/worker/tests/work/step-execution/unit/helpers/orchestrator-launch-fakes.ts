/**
 * Shared fakes + deps/launch-input builders for the single-container launch
 * orchestrator unit tests. Extracted so the base-launch tests and the
 * branch-per-step tests can share the same scaffolding without either file
 * exceeding the per-file line limit. No real Docker / devcontainer CLI / npm
 * payload / `docker exec` is used.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import { DirectProviderAccessResolver } from "../../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "../../../../../src/work/step-execution/infra/provider-access/session-runtime-config-materializer";
import { OpencodeRuntimePayloadProvisioner } from "../../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import {
  DevcontainerOpencodeBootstrap,
  CONTAINER_AGENT_HOME,
} from "../../../../../src/runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import type {
  PlanMountsInput,
  PlanMountsResult,
  StartInput,
  StartResult,
} from "../../../../../src/runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import type { OpencodeRuntimePayloadLocation } from "../../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import type {
  DevcontainerLauncher,
  LaunchDevcontainerInput,
  LaunchDevcontainerResult,
} from "../../../../../src/runtime/runtime-service/application/devcontainer-launcher";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../../../../../src/runtime/runtime-service/application/git-clone-service";
import type { GitCommitPushService } from "../../../../../src/runtime/runtime-service/application/git-commit-push-service";
import type {
  ProvisionedWorkspace,
  WorkspaceManager,
} from "../../../../../src/runtime/runtime-service/application/workspace-manager";
import {
  PROVIDER_ACCESS_ENV_VARS,
  type EnvSource,
} from "../../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";

export type PrepareAgentHomeInput = Parameters<
  DevcontainerOpencodeBootstrap["prepareAgentHome"]
>[0];
export type PrepareAgentHomeResult = Awaited<
  ReturnType<DevcontainerOpencodeBootstrap["prepareAgentHome"]>
>;

export const DEVCONTAINER_CONFIG_PATH = ".devcontainer/devcontainer.json";
export const DEVCONTAINER_JSON = JSON.stringify(
  {
    name: "orchestrator-launch-test",
    image: "mcr.microsoft.com/devcontainers/base:debian",
  },
  null,
  2,
);

export const FAKE_HOST_PORT = 54321;
export const FAKE_DEVCONTAINER_ID = "fake-devcontainer-id";
export const FAKE_PAYLOAD_VERSION = "1.17.3-test";

export function envFrom(values: Record<string, string>): EnvSource {
  return (name) => values[name];
}

/** Records a global, ordered log of orchestration steps for sequence asserts. */
export type CallLog = string[];

export class FakeWorkspaceManager implements WorkspaceManager {
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
export class FakeGitCloneService implements GitCloneService {
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

/**
 * Recording commit/push fake. With the branch-per-step flag OFF (the default in
 * the base tests) `launch` never invokes it; the branch tests flip the flag on
 * and assert against the recorded calls. `commitAll` reports "nothing to commit".
 */
export class FakeGitCommitPushService implements GitCommitPushService {
  checkoutBaseCalls: string[] = [];
  createBranchCalls: string[] = [];
  commitAllCalls: number = 0;
  pushCalls: string[] = [];
  constructor(private readonly log?: CallLog) {}
  checkoutBase(input: { baseWorkBranch: string }): Promise<void> {
    this.log?.push("checkoutBase");
    this.checkoutBaseCalls.push(input.baseWorkBranch);
    return Promise.resolve();
  }
  createBranch(input: { branchName: string }): Promise<void> {
    this.log?.push("createBranch");
    this.createBranchCalls.push(input.branchName);
    return Promise.resolve();
  }
  commitAll(): Promise<{ committed: boolean }> {
    this.commitAllCalls += 1;
    return Promise.resolve({ committed: false });
  }
  push(input: { branchName: string }): Promise<void> {
    this.pushCalls.push(input.branchName);
    return Promise.resolve();
  }
}

export class FakeDevcontainerLauncher implements DevcontainerLauncher {
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
export class FakePayloadProvisioner extends OpencodeRuntimePayloadProvisioner {
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
 * Bootstrap fake. planMounts returns fixed mounts + host port; patchConfig runs
 * the REAL devcontainer.json patch (so we can assert it happened before launch);
 * start/stop/cleanup are stubbed so no `docker exec` runs.
 */
export class FakeOpencodeBootstrap extends DevcontainerOpencodeBootstrap {
  planMountsCalls: PlanMountsInput[] = [];
  patchConfigInputs: { mounts: number; hostPort: number }[] = [];
  prepareAgentHomeCalls: PrepareAgentHomeInput[] = [];
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
  override prepareAgentHome(
    input: PrepareAgentHomeInput,
  ): Promise<PrepareAgentHomeResult> {
    this.log.push("prepareAgentHome");
    this.prepareAgentHomeCalls.push(input);
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

export type OrchestratorFakeDeps = {
  workspaceManager: FakeWorkspaceManager;
  gitCloneService: FakeGitCloneService;
  gitCommitPushService: FakeGitCommitPushService;
  devcontainerLauncher: FakeDevcontainerLauncher;
  payloadProvisioner: FakePayloadProvisioner;
  opencodeBootstrap: FakeOpencodeBootstrap;
  providerAccessResolver: DirectProviderAccessResolver;
  runtimeConfigMaterializer: SessionRuntimeConfigMaterializer;
};

/** Build the full fake deps set the orchestrator's constructor accepts. */
export function buildOrchestratorFakeDeps(input: {
  workspacePath: string;
  providerOutputDir: string;
  log: CallLog;
  gitCommitPushService?: FakeGitCommitPushService;
}): OrchestratorFakeDeps {
  const providerEnv = envFrom({
    [PROVIDER_ACCESS_ENV_VARS.baseUrl]: "https://api.example.com",
    [PROVIDER_ACCESS_ENV_VARS.tokenEnv]: "BOBODDY_TEST_TOKEN",
    BOBODDY_TEST_TOKEN: "secret-token",
  });
  return {
    workspaceManager: new FakeWorkspaceManager(input.workspacePath, input.log),
    gitCloneService: new FakeGitCloneService(input.log),
    gitCommitPushService:
      input.gitCommitPushService ?? new FakeGitCommitPushService(),
    devcontainerLauncher: new FakeDevcontainerLauncher(input.log),
    payloadProvisioner: new FakePayloadProvisioner(input.log),
    opencodeBootstrap: new FakeOpencodeBootstrap(input.log),
    providerAccessResolver: new DirectProviderAccessResolver({
      env: providerEnv,
      discover: () => Promise.resolve(undefined),
    }),
    runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
      outputBaseDir: input.providerOutputDir,
      env: providerEnv,
    }),
  };
}

/** A representative `workspace`-mode launch input. */
export function buildLaunchInput() {
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
