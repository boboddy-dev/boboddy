/**
 * The step's requested devcontainer config through the single-container launch
 * orchestrator: the requested path reaches `resolveConfigPath`, the resolved
 * path reaches the patchers, the launch and the returned environment, a missing
 * explicit config fails before launch naming path and branch, and the patched
 * config is kept out of the work-branch commit. Shares the launch fakes with
 * `local-project-runtime-environment.test.ts`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import { WORK_BRANCH_EXCLUDE_PATHS } from "../../../../src/work/step-execution/infra/work-branch-manager";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  DEVCONTAINER_CONFIG_PATH,
  FakeGitCommitPushService,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const ALT_CONFIG_PATH = ".devcontainer/alt/devcontainer.json";

describe("launch with a requested devcontainer config", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "orchestrator-provider-"),
    );
    await mkdir(path.join(workspacePath, ".devcontainer", "alt"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspacePath, ALT_CONFIG_PATH),
      JSON.stringify({ image: "alt-image", workspaceFolder: "/work/alt" }),
      "utf8",
    );
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

  test("hands the requested path to resolveConfigPath", async () => {
    const { deps, orchestrator } = setup();

    await orchestrator.launch({
      ...buildLaunchInput(),
      devcontainerConfigPath: ALT_CONFIG_PATH,
    });

    expect(deps.devcontainerLauncher.resolveConfigInputs).toEqual([
      { workspacePath, configPath: ALT_CONFIG_PATH },
    ]);
  });

  test("hands the resolved path to the patchers, the launch and the returned environment", async () => {
    const { deps, orchestrator } = setup();

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      devcontainerConfigPath: ALT_CONFIG_PATH,
    });

    expect(
      deps.opencodeBootstrap.patchConfigInputs.map(
        (patch) => patch.devcontainerConfigPath,
      ),
    ).toEqual([ALT_CONFIG_PATH]);
    expect(
      deps.devcontainerLauncher.launchInputs.map(
        (launch) => launch.devcontainerConfigPath,
      ),
    ).toEqual([ALT_CONFIG_PATH]);
    expect(env.devcontainerConfigPath).toBe(ALT_CONFIG_PATH);
  });

  test("derives the agent workspace folder from the requested config", async () => {
    const { deps, orchestrator } = setup();

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      devcontainerConfigPath: ALT_CONFIG_PATH,
    });

    expect(env.workspaceFolder).toBe("/work/alt");
    expect(deps.opencodeBootstrap.startInputs[0]?.workspaceFolder).toBe(
      "/work/alt",
    );
  });

  test("a null request resolves the canonical config as before", async () => {
    const { deps, orchestrator } = setup();

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      devcontainerConfigPath: null,
    });

    expect(deps.devcontainerLauncher.resolveConfigInputs).toEqual([
      { workspacePath, configPath: null },
    ]);
    expect(env.devcontainerConfigPath).toBe(DEVCONTAINER_CONFIG_PATH);
  });

  test("a missing requested config fails before launch, naming the path and the branch it was looked up on", async () => {
    const { log, deps, orchestrator } = setup();
    deps.devcontainerLauncher.resolveConfigPath = () =>
      Promise.reject(
        new Error(
          `Devcontainer config "${ALT_CONFIG_PATH}" not found in the cloned repository`,
        ),
      );

    let caught: unknown;
    try {
      await orchestrator.launch({
        ...buildLaunchInput(),
        stepKey: "perf",
        baseWorkBranch: "boboddy/prev-step",
        devcontainerConfigPath: ALT_CONFIG_PATH,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      `Devcontainer config "${ALT_CONFIG_PATH}" not found in the cloned repository (branch "boboddy/prev-step")`,
    );
    expect(log).not.toContain("launchDevcontainer");
    expect(log).not.toContain("patchMounts");
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });

  test("names the cloned default branch when the step is not based on another branch", async () => {
    const { deps, orchestrator } = setup();
    deps.devcontainerLauncher.resolveConfigPath = () =>
      Promise.reject(new Error("config missing"));

    let caught: unknown;
    try {
      await orchestrator.launch({
        ...buildLaunchInput(),
        stepKey: "perf",
        devcontainerConfigPath: ALT_CONFIG_PATH,
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toBe('config missing (branch "main")');
  });

  test("does not add branch context to an auto-detect failure", async () => {
    const { deps, orchestrator } = setup();
    deps.devcontainerLauncher.resolveConfigPath = () =>
      Promise.reject(new Error("No devcontainer spec found"));

    let caught: unknown;
    try {
      await orchestrator.launch({ ...buildLaunchInput(), stepKey: "perf" });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toBe("No devcontainer spec found");
  });

  test("keeps the patched requested config out of the work-branch commit", async () => {
    const { commitPush, orchestrator } = setup();

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "perf",
      devcontainerConfigPath: ALT_CONFIG_PATH,
    });
    await env.commitAndPushWorkBranch?.({ result: {} });

    expect(commitPush.commitAllExcludePaths).toEqual([
      [...WORK_BRANCH_EXCLUDE_PATHS, ALT_CONFIG_PATH],
    ]);
  });

  test("does not pass the canonical config to commitAll twice", async () => {
    const { commitPush, orchestrator } = setup();

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "perf",
    });
    await env.commitAndPushWorkBranch?.({ result: {} });

    expect(commitPush.commitAllExcludePaths).toEqual([
      [...WORK_BRANCH_EXCLUDE_PATHS],
    ]);
  });
});
