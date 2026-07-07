/**
 * Unit test for the `no_workspace` launch orchestrator
 * ({@link DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator}).
 *
 * The whole point of the `no_workspace` path is that OpenCode runs DIRECTLY ON
 * THE HOST against a throwaway temp working dir — there is NO git clone and NO
 * devcontainer. This test verifies exactly that by faking every external
 * boundary and asserting the returned environment shape + the host bootstrap
 * wiring + cleanup semantics:
 *
 *   - the returned env has `runtimeContainerId === null` (not a container),
 *     a non-empty `workspaceFolder` under the OS temp dir, and `hostAgentLogPath`
 *     set (so the monitor tails the host file rather than `docker exec`),
 *   - `hostOpencodeBootstrap.start` is called with the expected wrapper path,
 *     the materialized provider env, the built config content, and the workspace
 *     folder wiring,
 *   - `cleanup()` stops the host process AND removes the real temp working dir,
 *   - a failure in `hostOpencodeBootstrap.start` still triggers cleanup (temp
 *     dir removed, stop called) and rethrows.
 *
 * Fakes:
 *   - OpencodeRuntimePayloadProvisioner: subclassed (nominal type: private
 *     fields), `ensure()` returns a fake payload dir without touching the npm
 *     registry.
 *   - HostOpencodeBootstrap: subclassed (nominal type: private `waitForHealth`),
 *     `start` records its input + returns a fake started result WITHOUT spawning
 *     a process; `stop` records the pid.
 *   - Provider access: the real DirectProviderAccessResolver +
 *     SessionRuntimeConfigMaterializer driven by an explicit env override (no
 *     host credential discovery), matching the workspace-path test.
 *   - The real fs is used for the temp working dir (the code uses real fs and it
 *     is cheap); the test removes any dirs it creates in `afterEach`.
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-noworkspace-runtime-environment";
import {
  DirectProviderAccessResolver,
  PROVIDER_ACCESS_ENV_VARS,
  type EnvSource,
} from "../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "../../../../src/work/step-execution/infra/provider-access/session-runtime-config-materializer";
import { OpencodeRuntimePayloadProvisioner } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import type { OpencodeRuntimePayloadLocation } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import {
  HostOpencodeBootstrap,
  type HostStartInput,
  type HostStartResult,
} from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { LAUNCH_WRAPPER_FILENAME } from "../../../../src/runtime/runtime-service/domain/opencode-runtime-payload";

const FAKE_PAYLOAD_VERSION = "1.17.3-test";
const FAKE_HOST_PAYLOAD_DIR = "/host/payload";
const FAKE_HOST_PID = 424242;

function envFrom(values: Record<string, string>): EnvSource {
  return (name) => values[name];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Payload provisioner fake. `OpencodeRuntimePayloadProvisioner` carries private
 * fields (nominal type), so subclass and override the single public method used
 * by the orchestrator instead of supplying a structural fake.
 */
class FakePayloadProvisioner extends OpencodeRuntimePayloadProvisioner {
  ensureCalls = 0;
  override ensure(): Promise<OpencodeRuntimePayloadLocation> {
    this.ensureCalls += 1;
    return Promise.resolve({
      version: FAKE_PAYLOAD_VERSION,
      hostPayloadDir: FAKE_HOST_PAYLOAD_DIR,
      containerPayloadDir: `/opt/boboddy/runtimes/opencode/${FAKE_PAYLOAD_VERSION}`,
      containerLaunchWrapperPath: `/opt/boboddy/runtimes/opencode/${FAKE_PAYLOAD_VERSION}/${LAUNCH_WRAPPER_FILENAME}`,
    });
  }
}

/**
 * Host bootstrap fake. `HostOpencodeBootstrap` is a nominal type (private
 * `waitForHealth`), so subclass and override `start`/`stop`. `start` records its
 * input and returns a fake started result WITHOUT spawning a real process.
 */
class FakeHostOpencodeBootstrap extends HostOpencodeBootstrap {
  startInputs: HostStartInput[] = [];
  stopCalls: (number | null | undefined)[] = [];
  shouldFail = false;
  override start(input: HostStartInput): Promise<HostStartResult> {
    this.startInputs.push(input);
    if (this.shouldFail) {
      return Promise.reject(new Error("host opencode failed to become healthy"));
    }
    const agentLogDirectory = path.join(
      input.sessionAgentHomeDir,
      ".boboddy-log",
    );
    return Promise.resolve({
      agentBaseUrl: "http://127.0.0.1:54999",
      agentLogDirectory,
      agentLogPath: path.join(agentLogDirectory, "opencode-serve.log"),
      pid: FAKE_HOST_PID,
    });
  }
  override stop(pid: number | null | undefined): void {
    this.stopCalls.push(pid);
  }
}

describe("DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator.launch (host, no clone/devcontainer)", () => {
  let providerOutputDir: string;
  // Track temp working dirs created via the real launch so they are always torn
  // down even if an assertion or the code under test throws.
  const createdSessionIds: string[] = [];

  beforeEach(async () => {
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "noworkspace-provider-"),
    );
  });

  afterEach(async () => {
    await rm(providerOutputDir, { recursive: true, force: true });
    await Promise.all(
      createdSessionIds.map((sessionId) =>
        Promise.all([
          rm(path.join(os.tmpdir(), "boboddy-noworkspace", sessionId), {
            recursive: true,
            force: true,
          }),
          rm(path.join(os.tmpdir(), "boboddy-agent-homes", sessionId), {
            recursive: true,
            force: true,
          }),
        ]),
      ),
    );
    createdSessionIds.length = 0;
  });

  function buildDeps() {
    const payloadProvisioner = new FakePayloadProvisioner();
    const hostOpencodeBootstrap = new FakeHostOpencodeBootstrap();
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
      payloadProvisioner,
      providerAccessResolver,
      runtimeConfigMaterializer,
      hostOpencodeBootstrap,
    };
  }

  function launchInput() {
    const sessionId = createUuidV7();
    createdSessionIds.push(sessionId);
    return {
      sessionId,
      projectId: createUuidV7(),
      requestedByUserId: createUuidV7(),
      gitUrl: "https://example.com/repo.git",
      currentExecutionInfo: {
        stepExecutionId: createUuidV7(),
        resultSchemaJson: null,
      },
    };
  }

  test("returns a host (no-container) environment: null container id, temp workspace folder, host agent log path", async () => {
    const deps = buildDeps();
    const orchestrator =
      new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(undefined, deps);

    const input = launchInput();
    const env = await orchestrator.launch(input);

    // No container: callers must treat this as "not a container".
    expect(env.runtimeContainerId).toBeNull();
    // OpenCode runs directly against the throwaway temp working dir on the host.
    const expectedWorkspace = path.join(
      os.tmpdir(),
      "boboddy-noworkspace",
      input.sessionId,
    );
    expect(env.workspaceFolder).toBe(expectedWorkspace);
    expect(env.workspacePath).toBe(expectedWorkspace);
    expect(env.workspaceFolder.length).toBeGreaterThan(0);
    // The temp working dir was really created on disk.
    expect(await pathExists(expectedWorkspace)).toBe(true);
    // Host log path is set so the monitor tails the host file (not docker exec).
    expect(env.hostAgentLogPath).toBeTruthy();
    // No clone → no resolved branch; no devcontainer → no config path/network.
    expect(env.resolvedBranch).toBe("");
    expect(env.devcontainerConfigPath).toBe("");
    expect(env.networkName).toBe("");
    // The aiImage field surfaces the pinned runtime version, not a docker image.
    expect(env.aiImage).toBe(`opencode-runtime@${FAKE_PAYLOAD_VERSION}`);

    await env.cleanup();
  });

  test("starts host OpenCode with the payload wrapper path, provider env, config content, and workspace-folder wiring", async () => {
    const deps = buildDeps();
    const orchestrator =
      new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(undefined, deps);

    const input = launchInput();
    const env = await orchestrator.launch(input);

    expect(deps.hostOpencodeBootstrap.startInputs).toHaveLength(1);
    const start = deps.hostOpencodeBootstrap.startInputs[0];
    // Launched by the payload's host launch wrapper (launch.sh).
    expect(start?.hostLaunchWrapperPath).toBe(
      path.join(FAKE_HOST_PAYLOAD_DIR, LAUNCH_WRAPPER_FILENAME),
    );
    // The workspace folder handed to the host process is the temp working dir.
    expect(start?.workspaceFolder).toBe(
      path.join(os.tmpdir(), "boboddy-noworkspace", input.sessionId),
    );
    // Provider env was materialized from the explicit worker env override and
    // handed to the host process (token under its tokenEnv name + base URL).
    expect(start?.providerEnv["BOBODDY_TEST_TOKEN"]).toBe("secret-token");
    expect(start?.providerEnv["BOBODDY_PROVIDER_BASE_URL"]).toBe(
      "https://api.example.com",
    );
    // Boboddy's override config is passed inline as OPENCODE_CONFIG_CONTENT.
    expect(start?.opencodeConfigContent).toBeDefined();
    expect(() => {
      JSON.parse(start?.opencodeConfigContent ?? "");
    }).not.toThrow();
    // The materialized provider token is surfaced as a secret for log masking.
    expect(env.secretValues).toContain("secret-token");

    await env.cleanup();
  });

  test("cleanup stops the host process and removes the temp working dir", async () => {
    const deps = buildDeps();
    const orchestrator =
      new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(undefined, deps);

    const input = launchInput();
    const env = await orchestrator.launch(input);
    const workspaceFolder = env.workspaceFolder;
    expect(await pathExists(workspaceFolder)).toBe(true);

    await env.cleanup();

    // The host process was stopped by pid, and the temp working dir is gone.
    expect(deps.hostOpencodeBootstrap.stopCalls).toEqual([FAKE_HOST_PID]);
    expect(await pathExists(workspaceFolder)).toBe(false);
  });

  test("a failure starting host OpenCode triggers cleanup (temp dir removed, stop called) and rethrows", async () => {
    const deps = buildDeps();
    deps.hostOpencodeBootstrap.shouldFail = true;
    const orchestrator =
      new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(undefined, deps);

    const input = launchInput();
    const expectedWorkspace = path.join(
      os.tmpdir(),
      "boboddy-noworkspace",
      input.sessionId,
    );

    let caught: unknown;
    try {
      await orchestrator.launch(input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /host opencode failed to become healthy/,
    );
    // The partial temp working dir was cleaned up on the failure path.
    expect(await pathExists(expectedWorkspace)).toBe(false);
    // stop() was invoked during failure cleanup (pid is null since start threw
    // before returning one).
    expect(deps.hostOpencodeBootstrap.stopCalls).toEqual([null]);
  });
});
