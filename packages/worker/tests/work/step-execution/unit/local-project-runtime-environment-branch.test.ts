/**
 * Branch-per-step behavior for the single-container launch orchestrator (always
 * on for `workspace` steps). Shares the launch fakes with the base sequence
 * tests (see `helpers/orchestrator-launch-fakes.ts`).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("branch-per-step launch", () => {
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

  test("first step: creates boboddy/<key>-<id> off the resolved clone branch and surfaces it on the env", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const stepExecutionId = createUuidV7();
    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "build code",
      currentExecutionInfo: { stepExecutionId, resultSchemaJson: null },
    });

    const expectedBranch = `boboddy/build-code-${stepExecutionId}`;
    // First step: no base checkout, just create off the clone branch.
    expect(commitPush.checkoutBaseCalls).toEqual([]);
    expect(commitPush.createBranchCalls).toEqual([expectedBranch]);
    expect(env.workBranch).toBe(expectedBranch);
    expect(env.createdFromBranch).toBe("main");
    // Branch creation happens right after clone, before the container launch.
    expect(log.indexOf("createBranch")).toBeGreaterThan(log.indexOf("clone"));
    expect(log.indexOf("createBranch")).toBeLessThan(
      log.indexOf("launchDevcontainer"),
    );
  });

  test("first step: uses the branchPrefix from the repo's .boboddy/boboddy.jsonc", async () => {
    // Seed the (already-created) workspace with a project config that overrides
    // the branch prefix. The orchestrator reads it after clone.
    await mkdir(path.join(workspacePath, ".boboddy"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".boboddy", "boboddy.jsonc"),
      JSON.stringify({ projectId: "proj-1", branchPrefix: "myteam" }),
      "utf8",
    );

    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const stepExecutionId = createUuidV7();
    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "build",
      currentExecutionInfo: { stepExecutionId, resultSchemaJson: null },
    });

    const expectedBranch = `myteam/build-${stepExecutionId}`;
    expect(commitPush.createBranchCalls).toEqual([expectedBranch]);
    expect(env.workBranch).toBe(expectedBranch);
  });

  test("later step: checks out baseWorkBranch first and sets createdFromBranch = baseWorkBranch", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const stepExecutionId = createUuidV7();
    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "review",
      baseWorkBranch: "boboddy/prev-step",
      currentExecutionInfo: { stepExecutionId, resultSchemaJson: null },
    });

    expect(commitPush.checkoutBaseCalls).toEqual(["boboddy/prev-step"]);
    expect(commitPush.createBranchCalls).toEqual([
      `boboddy/review-${stepExecutionId}`,
    ]);
    expect(env.createdFromBranch).toBe("boboddy/prev-step");
    // checkoutBase precedes createBranch.
    expect(log.indexOf("checkoutBase")).toBeLessThan(
      log.indexOf("createBranch"),
    );
  });

  test("commitAndPushWorkBranch closure commits then pushes the work branch", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const stepExecutionId = createUuidV7();
    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "impl",
      currentExecutionInfo: { stepExecutionId, resultSchemaJson: null },
    });

    expect(env.commitAndPushWorkBranch).toBeDefined();
    await env.commitAndPushWorkBranch?.();
    expect(commitPush.commitAllCalls).toBe(1);
    expect(commitPush.pushCalls).toEqual([`boboddy/impl-${stepExecutionId}`]);
  });

  test("push failure inside the closure does not throw (step still succeeds)", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    commitPush.push = () => Promise.reject(new Error("remote rejected"));
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      stepKey: "impl",
    });

    // The closure swallows push failures per the locked failure policy.
    const commitAndPush = env.commitAndPushWorkBranch;
    expect(commitAndPush).toBeDefined();
    let threw = false;
    try {
      await commitAndPush?.();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(commitPush.pushCalls).toEqual([]);
  });

  test("no work branch fields are set when no step key is provided", async () => {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const orchestrator = orchestratorFor(buildDeps(log, commitPush));

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      // stepKey intentionally omitted.
    });

    expect(commitPush.createBranchCalls).toEqual([]);
    expect(env.workBranch).toBeNull();
    expect(env.createdFromBranch).toBeNull();
    expect(env.commitAndPushWorkBranch).toBeUndefined();
  });
});
