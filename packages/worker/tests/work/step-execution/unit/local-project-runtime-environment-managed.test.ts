/**
 * A step's managed runtime through the single-container launch orchestrator:
 * the synthesized config replaces config resolution, its path reaches the
 * patchers, the launch and the returned environment, an unknown identifier
 * fails before anything is cloned, and the config and the install's artifacts
 * stay out of the work-branch commit. Shares the launch fakes with
 * `local-project-runtime-environment-config-path.test.ts`.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PIPELINE_BUILDER_DIR } from "@boboddy/sdk/push";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import { WORK_BRANCH_EXCLUDE_PATHS } from "../../../../src/work/step-execution/infra/work-branch-manager";
import { MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS } from "../../../../src/runtime/runtime-service/domain/managed-runtimes";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  FakeGitCommitPushService,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const BUN1_CONFIG_PATH =
  ".boboddy/managed-devcontainers/bun1/devcontainer.json";
const NODE24_CONFIG_PATH =
  ".boboddy/managed-devcontainers/node24/devcontainer.json";

describe("launch with a managed runtime", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "orchestrator-provider-"),
    );
    await mkdir(path.join(workspacePath, PIPELINE_BUILDER_DIR), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function setup() {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
      gitCommitPushService: commitPush,
    });
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );
    return { log, commitPush, deps, orchestrator };
  }

  function launchInput(managedRuntime: string | null) {
    return { ...buildLaunchInput(), startAgent: false, managedRuntime };
  }

  test("hands the launcher the synthesized config instead of resolving one from the clone", async () => {
    const { deps, orchestrator } = setup();

    const env = await orchestrator.launch(launchInput("bun1"));

    expect(deps.devcontainerLauncher.resolveConfigInputs).toEqual([]);
    expect(
      deps.devcontainerLauncher.launchInputs.map(
        (launch) => launch.devcontainerConfigPath,
      ),
    ).toEqual([BUN1_CONFIG_PATH]);
    expect(env.devcontainerConfigPath).toBe(BUN1_CONFIG_PATH);
  });

  test("writes the config for the identifier into the clone before the launch", async () => {
    const { deps, orchestrator } = setup();
    let configAtLaunch: unknown;
    const launch = deps.devcontainerLauncher.launch.bind(
      deps.devcontainerLauncher,
    );
    deps.devcontainerLauncher.launch = async (input) => {
      configAtLaunch = JSON.parse(
        await readFile(
          path.join(input.workspacePath, input.devcontainerConfigPath),
          "utf8",
        ),
      );
      return launch(input);
    };

    await orchestrator.launch(launchInput("node24"));

    expect(configAtLaunch).toMatchObject({
      image: "node:24-bookworm-slim",
      remoteUser: "node",
    });
  });

  test("uses the identifier's own config path", async () => {
    const { deps, orchestrator } = setup();

    await orchestrator.launch(launchInput("node24"));

    expect(
      deps.devcontainerLauncher.launchInputs.map(
        (launch) => launch.devcontainerConfigPath,
      ),
    ).toEqual([NODE24_CONFIG_PATH]);
  });

  test("falls back to the agent workspace convention, since the config declares no workspaceFolder", async () => {
    const { orchestrator } = setup();

    const env = await orchestrator.launch(launchInput("bun1"));

    expect(env.workspaceFolder).toBe(
      `/workspaces/${path.basename(workspacePath)}`,
    );
  });

  test("a null managed runtime resolves the config from the clone as before", async () => {
    const { deps, orchestrator } = setup();

    await orchestrator.launch(launchInput(null));

    expect(deps.devcontainerLauncher.resolveConfigInputs).toHaveLength(1);
  });

  test("an unknown identifier fails before the workspace is created, naming it and the supported ones", async () => {
    const { log, deps, orchestrator } = setup();

    let caught: unknown;
    try {
      await orchestrator.launch(launchInput("bun9"));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Managed runtime "bun9" is not supported by this worker. ' +
        "Supported managed runtimes: bun1, node24. " +
        "Upgrade the Boboddy CLI to a version that supports it.",
    );
    expect(log).toEqual([]);
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
  });

  test("keeps the config and the install artifacts out of the work-branch commit", async () => {
    const { commitPush, orchestrator } = setup();

    const env = await orchestrator.launch({
      ...launchInput("bun1"),
      stepKey: "lookup",
    });
    await env.commitAndPushWorkBranch?.({ result: {} });

    expect(commitPush.commitAllExcludePaths).toEqual([
      [
        ...WORK_BRANCH_EXCLUDE_PATHS,
        BUN1_CONFIG_PATH,
        ...MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS,
      ],
    ]);
    expect(commitPush.commitAllExcludePaths[0]).toContain(
      ".boboddy/managed-devcontainers",
    );
    expect(commitPush.commitAllExcludePaths[0]).toContain(
      ".boboddy/pipeline-builder/node_modules",
    );
  });

  test("a step without a managed runtime passes no install artifacts to the commit", async () => {
    const { commitPush, orchestrator } = setup();

    const env = await orchestrator.launch({
      ...launchInput(null),
      stepKey: "lookup",
    });
    await env.commitAndPushWorkBranch?.({ result: {} });

    expect(commitPush.commitAllExcludePaths).toEqual([
      [...WORK_BRANCH_EXCLUDE_PATHS],
    ]);
  });
});
