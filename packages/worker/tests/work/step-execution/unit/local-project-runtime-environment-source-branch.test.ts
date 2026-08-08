/**
 * `sourceBranch` (the CLI's resolved/overridden current local branch) behavior
 * for the single-container launch orchestrator. Shares the launch fakes with
 * the base sequence and branch-per-step tests (see
 * `helpers/orchestrator-launch-fakes.ts`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  FakeGitCommitPushService,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

describe("sourceBranch launch behavior", () => {
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

  function buildDeps(log: CallLog, commitPush: FakeGitCommitPushService) {
    return buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
      gitCommitPushService: commitPush,
    });
  }

  function orchestratorFor(deps: ReturnType<typeof buildDeps>) {
    return new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );
  }

  test("first step: checks out sourceBranch and creates the work branch off it", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const stepExecutionId = createUuidV7();
    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "build",
      sourceBranch: "feature-x",
      currentExecutionInfo: { stepExecutionId, resultSchemaJson: null },
    });

    expect(commitPush.checkoutBaseCalls).toEqual(["feature-x"]);
    expect(commitPush.createBranchCalls).toEqual([
      `boboddy/build-${stepExecutionId}`,
    ]);
    expect(env.createdFromBranch).toBe("feature-x");
    // Checkout happens right after clone, before the container launch.
    expect(log.indexOf("checkoutBase")).toBeGreaterThan(log.indexOf("clone"));
    expect(log.indexOf("checkoutBase")).toBeLessThan(
      log.indexOf("resolveConfigPath"),
    );
  });

  test("later step: server-handed baseWorkBranch wins over sourceBranch (unaffected)", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const stepExecutionId = createUuidV7();
    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "review",
      baseWorkBranch: "boboddy/prev-step",
      sourceBranch: "feature-x",
      currentExecutionInfo: { stepExecutionId, resultSchemaJson: null },
    });

    // Only ONE checkout: off the predecessor's branch, never sourceBranch.
    expect(commitPush.checkoutBaseCalls).toEqual(["boboddy/prev-step"]);
    expect(env.createdFromBranch).toBe("boboddy/prev-step");
  });

  test("no step key (dry run): still checks out sourceBranch even though no work branch is created", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      sourceBranch: "feature-x",
      // stepKey intentionally omitted (dry run shape).
    });

    expect(commitPush.checkoutBaseCalls).toEqual(["feature-x"]);
    expect(commitPush.createBranchCalls).toEqual([]);
    expect(env.workBranch).toBeNull();
    expect(env.createdFromBranch).toBeNull();
    // Checkout still precedes devcontainer config resolution.
    expect(log.indexOf("checkoutBase")).toBeLessThan(
      log.indexOf("resolveConfigPath"),
    );
  });

  test("no sourceBranch and no baseWorkBranch: no checkout, unchanged from prior behavior", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "build",
      currentExecutionInfo: {
        stepExecutionId: createUuidV7(),
        resultSchemaJson: null,
      },
    });

    expect(commitPush.checkoutBaseCalls).toEqual([]);
    expect(env.createdFromBranch).toBe("main");
  });
});
