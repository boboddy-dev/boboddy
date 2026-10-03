/**
 * Unit tests for `buildWorkBranchName`: the work-branch naming, including the
 * configurable `branchPrefix` (from the repo's `.boboddy/boboddy.jsonc`) and
 * its default/fallback behavior; and for the paths `buildCommitAndPushWorkBranch`
 * keeps out of the commit.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCommitAndPushWorkBranch,
  buildWorkBranchName,
  checkoutBaseBranch,
  WORK_BRANCH_EXCLUDE_PATHS,
} from "../../../../src/work/step-execution/infra/work-branch-manager";
import {
  FakeGitCommitPushService,
  FakeSubmoduleService,
} from "./helpers/orchestrator-launch-fakes";

const STEP_EXECUTION_ID = "0192f000-0000-7000-8000-000000000000";

describe("buildWorkBranchName", () => {
  test("defaults to the boboddy prefix when branchPrefix is undefined", () => {
    expect(
      buildWorkBranchName({
        stepKey: "build",
        stepExecutionId: STEP_EXECUTION_ID,
      }),
    ).toBe(`boboddy/build-${STEP_EXECUTION_ID}`);
  });

  test("defaults to the boboddy prefix when branchPrefix is null", () => {
    expect(
      buildWorkBranchName({
        stepKey: "build",
        stepExecutionId: STEP_EXECUTION_ID,
        branchPrefix: null,
      }),
    ).toBe(`boboddy/build-${STEP_EXECUTION_ID}`);
  });

  test("uses a valid custom prefix", () => {
    expect(
      buildWorkBranchName({
        stepKey: "build",
        stepExecutionId: STEP_EXECUTION_ID,
        branchPrefix: "myteam",
      }),
    ).toBe(`myteam/build-${STEP_EXECUTION_ID}`);
  });

  test("sanitizes the step key", () => {
    expect(
      buildWorkBranchName({
        stepKey: "build code",
        stepExecutionId: STEP_EXECUTION_ID,
      }),
    ).toBe(`boboddy/build-code-${STEP_EXECUTION_ID}`);
  });

  test("sanitizes a custom prefix (spaces, unsafe chars, leading dash)", () => {
    expect(
      buildWorkBranchName({
        stepKey: "build",
        stepExecutionId: STEP_EXECUTION_ID,
        branchPrefix: " -my team~ ",
      }),
    ).toBe(`my-team/build-${STEP_EXECUTION_ID}`);
  });

  test("falls back to boboddy when the prefix is only whitespace", () => {
    expect(
      buildWorkBranchName({
        stepKey: "build",
        stepExecutionId: STEP_EXECUTION_ID,
        branchPrefix: "   ",
      }),
    ).toBe(`boboddy/build-${STEP_EXECUTION_ID}`);
  });

  test("falls back to boboddy when the prefix sanitizes to empty", () => {
    // "--" strips to empty -> sanitizer placeholder -> default prefix.
    expect(
      buildWorkBranchName({
        stepKey: "build",
        stepExecutionId: STEP_EXECUTION_ID,
        branchPrefix: "--",
      }),
    ).toBe(`boboddy/build-${STEP_EXECUTION_ID}`);
  });

  test("honors a literal 'step' prefix (not treated as invalid)", () => {
    expect(
      buildWorkBranchName({
        stepKey: "build",
        stepExecutionId: STEP_EXECUTION_ID,
        branchPrefix: "step",
      }),
    ).toBe(`step/build-${STEP_EXECUTION_ID}`);
  });
});

describe("buildCommitAndPushWorkBranch exclude paths", () => {
  async function commitExcludePaths(
    extraExcludePaths?: readonly string[],
  ): Promise<readonly string[] | undefined> {
    const commitPush = new FakeGitCommitPushService();
    await buildCommitAndPushWorkBranch({
      gitCommitPushService: commitPush,
      submoduleService: new FakeSubmoduleService(),
      workspacePath: "/workspace",
      workBranch: "boboddy/build-1",
      stepExecutionId: STEP_EXECUTION_ID,
      extraExcludePaths,
    })({ result: {} });
    return commitPush.commitAllExcludePaths[0];
  }

  test("still excludes exactly the default runtime files when no extra path is given", async () => {
    expect(await commitExcludePaths()).toEqual([...WORK_BRANCH_EXCLUDE_PATHS]);
  });

  test("excludes a custom devcontainer config path alongside the defaults", async () => {
    expect(
      await commitExcludePaths([".devcontainer/alt/devcontainer.json"]),
    ).toEqual([
      ...WORK_BRANCH_EXCLUDE_PATHS,
      ".devcontainer/alt/devcontainer.json",
    ]);
  });

  test("excludes a root-level devcontainer.json", async () => {
    expect(await commitExcludePaths(["devcontainer.json"])).toContain(
      "devcontainer.json",
    );
  });

  test("does not pass the canonical config twice when it is also the extra path", async () => {
    const excluded = await commitExcludePaths([
      ".devcontainer/devcontainer.json",
    ]);

    expect(excluded).toEqual([...WORK_BRANCH_EXCLUDE_PATHS]);
    expect(
      excluded?.filter((entry) => entry === ".devcontainer/devcontainer.json"),
    ).toHaveLength(1);
  });
});

describe("checkoutBaseBranch", () => {
  test("checks out a configured base and returns it", async () => {
    const commitPush = new FakeGitCommitPushService();

    const base = await checkoutBaseBranch({
      gitCommitPushService: commitPush,
      workspacePath: "/workspace",
      resolvedBranch: "main",
      baseWorkBranch: "boboddy/prev-step",
    });

    expect(base).toBe("boboddy/prev-step");
    expect(commitPush.checkoutBaseCalls).toEqual(["boboddy/prev-step"]);
    expect(commitPush.createBranchCalls).toEqual([]);
  });

  test("with no base, checks nothing out and returns the resolved clone branch", async () => {
    const commitPush = new FakeGitCommitPushService();

    const base = await checkoutBaseBranch({
      gitCommitPushService: commitPush,
      workspacePath: "/workspace",
      resolvedBranch: "main",
      baseWorkBranch: null,
    });

    expect(base).toBe("main");
    expect(commitPush.checkoutBaseCalls).toEqual([]);
  });
});
