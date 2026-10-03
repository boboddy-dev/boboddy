/**
 * How the step's resolved `repo` shapes the single-container launch: `readOnly`
 * checks out the base but creates no work branch, `readWrite` options reach the
 * commit closure, and `none` is rejected. Shares the launch fakes with the other
 * orchestrator tests (see `helpers/orchestrator-launch-fakes.ts`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RepoConfig } from "@boboddy/sdk/repo-config";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { captureRejection } from "../../../support/capture-rejection";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  DEVCONTAINER_CONFIG_PATH,
  FakeGitCommitPushService,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const READ_ONLY: RepoConfig = { mode: "readOnly" };

describe("repo mode launch", () => {
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

  describe("readOnly", () => {
    test("reports no work branch and no created-from branch, and creates none", async () => {
      const { commitPush, orchestrator } = setup();

      const env = await orchestrator.launch({
        ...buildLaunchInput(),
        repo: READ_ONLY,
        stepKey: "triage",
      });

      expect(env.workBranch).toBeNull();
      expect(env.createdFromBranch).toBeNull();
      expect(env.resolvedBranch).toBe("main");
      expect(commitPush.createBranchCalls).toEqual([]);
    });

    test("has no commit/push closure, so nothing is ever committed or pushed", async () => {
      const { commitPush, orchestrator } = setup();

      const env = await orchestrator.launch({
        ...buildLaunchInput(),
        repo: READ_ONLY,
        stepKey: "triage",
      });
      await env.commitAndPushWorkBranch?.({ result: {} });

      expect(env.commitAndPushWorkBranch).toBeUndefined();
      expect(commitPush.createBranchCalls).toEqual([]);
      expect(commitPush.commitAllCalls).toBe(0);
      expect(commitPush.pushCalls).toEqual([]);
    });

    test("still checks out the server-handed base branch, before the container launches", async () => {
      const { log, commitPush, orchestrator } = setup();

      await orchestrator.launch({
        ...buildLaunchInput(),
        repo: READ_ONLY,
        stepKey: "review",
        baseWorkBranch: "boboddy/prev-step",
      });

      expect(commitPush.checkoutBaseCalls).toEqual(["boboddy/prev-step"]);
      expect(log.indexOf("checkoutBase")).toBeGreaterThan(log.indexOf("clone"));
      expect(log.indexOf("checkoutBase")).toBeLessThan(
        log.indexOf("launchDevcontainer"),
      );
    });

    test("checks out the CLI source branch on a first step", async () => {
      const { commitPush, orchestrator } = setup();

      await orchestrator.launch({
        ...buildLaunchInput(),
        repo: READ_ONLY,
        stepKey: "triage",
        sourceBranch: "feature/x",
      });

      expect(commitPush.checkoutBaseCalls).toEqual(["feature/x"]);
    });

    test("with no base at all, checks nothing out and the workspace stays on the clone branch", async () => {
      const { commitPush, orchestrator } = setup();

      const env = await orchestrator.launch({
        ...buildLaunchInput(),
        repo: READ_ONLY,
        stepKey: "triage",
      });

      expect(commitPush.checkoutBaseCalls).toEqual([]);
      expect(env.resolvedBranch).toBe("main");
    });

    test("looks a requested devcontainer config up on the base branch", async () => {
      const { deps, orchestrator } = setup();
      deps.devcontainerLauncher.resolveConfigPath = () =>
        Promise.reject(new Error("no devcontainer config"));

      const failure = await captureRejection(
        orchestrator.launch({
          ...buildLaunchInput(),
          repo: READ_ONLY,
          stepKey: "review",
          baseWorkBranch: "boboddy/prev-step",
          devcontainerConfigPath: ".devcontainer/alt/devcontainer.json",
        }),
      );

      expect(failure.message).toContain('branch "boboddy/prev-step"');
    });

    test("still resolves and launches the devcontainer config", async () => {
      const { deps, orchestrator } = setup();

      const env = await orchestrator.launch({
        ...buildLaunchInput(),
        repo: READ_ONLY,
        stepKey: "triage",
      });

      expect(env.devcontainerConfigPath).toBe(DEVCONTAINER_CONFIG_PATH);
      expect(deps.devcontainerLauncher.launchInputs).toHaveLength(1);
    });
  });

  describe("readWrite", () => {
    test("the default config matches the pre-repo behavior: branch, default message, push", async () => {
      const { commitPush, orchestrator } = setup();

      const stepExecutionId = createUuidV7();
      const env = await orchestrator.launch({
        ...buildLaunchInput(),
        stepKey: "impl",
        currentExecutionInfo: { stepExecutionId, resultSchemaJson: null },
      });
      await env.commitAndPushWorkBranch?.({ result: { summary: "done" } });

      const branch = `boboddy/impl-${stepExecutionId}`;
      expect(env.workBranch).toBe(branch);
      expect(env.createdFromBranch).toBe("main");
      expect(commitPush.createBranchCalls).toEqual([branch]);
      expect(commitPush.commitAllMessages).toEqual([
        `boboddy: step ${stepExecutionId}`,
      ]);
      expect(commitPush.pushCalls).toEqual([branch]);
    });

    test("renders the message template from the step input and the submitted result", async () => {
      const { commitPush, orchestrator } = setup();

      const env = await orchestrator.launch({
        ...buildLaunchInput(),
        repo: {
          mode: "readWrite",
          message: "{{input.ticket}}: {{result.summary}}",
          onPushFailure: "fail",
        },
        stepInputJson: { ticket: "ENG-42" },
        stepKey: "impl",
      });
      await env.commitAndPushWorkBranch?.({ result: { summary: "add retry" } });

      expect(commitPush.commitAllMessages).toEqual(["ENG-42: add retry"]);
    });

    test("without a step key there is no work branch and no closure, as before", async () => {
      const { commitPush, orchestrator } = setup();

      const env = await orchestrator.launch({ ...buildLaunchInput() });

      expect(env.workBranch).toBeNull();
      expect(env.commitAndPushWorkBranch).toBeUndefined();
      expect(commitPush.createBranchCalls).toEqual([]);
    });
  });

  describe("none", () => {
    test("is rejected loudly, before anything is cloned", async () => {
      const { log, commitPush, orchestrator } = setup();

      const failure = await captureRejection(
        orchestrator.launch({
          ...buildLaunchInput(),
          repo: { mode: "none" },
          stepKey: "impl",
        }),
      );

      expect(failure.message).toContain('repo mode "none"');

      expect(log).toEqual([]);
      expect(commitPush.createBranchCalls).toEqual([]);
    });
  });
});
