/**
 * `buildCommitAndPushWorkBranch`'s `readWrite` options: the rendered commit
 * message and the `onPushFailure` policy, for the superproject push and for
 * submodule pushes. Uses the recording fakes, no real git (the real-git
 * submodule cases live under tests/runtime/runtime-service/unit).
 */
import { describe, expect, test } from "bun:test";
import type { RepoOnPushFailure } from "@boboddy/sdk/repo-config";
import type { AnyJsonValue } from "../../../../src/common/contracts/json";
import {
  buildCommitAndPushWorkBranch,
  WORK_BRANCH_EXCLUDE_PATHS,
  WorkBranchPushError,
} from "../../../../src/work/step-execution/infra/work-branch-manager";
import { captureRejection } from "../../../support/capture-rejection";
import { MAX_COMMIT_SUBJECT_LENGTH } from "../../../../src/work/step-execution/infra/work-branch-commit-message";
import {
  FakeGitCommitPushService,
  FakeSubmoduleService,
} from "./helpers/orchestrator-launch-fakes";

const STEP_EXECUTION_ID = "0192f000-0000-7000-8000-000000000000";
const WORK_BRANCH = "boboddy/build-1";
const DEFAULT_MESSAGE = `boboddy: step ${STEP_EXECUTION_ID}`;

type CommitOptions = {
  message?: string | null;
  inputJson?: Record<string, string>;
  onPushFailure?: RepoOnPushFailure;
};

async function runCommitWithOutcome(
  options: CommitOptions & { result?: AnyJsonValue },
  commitPush = new FakeGitCommitPushService(),
  submoduleService = new FakeSubmoduleService(),
) {
  const { result = {}, ...rest } = options;
  const outcome = await buildCommitAndPushWorkBranch({
    gitCommitPushService: commitPush,
    submoduleService,
    workspacePath: "/workspace",
    workBranch: WORK_BRANCH,
    stepExecutionId: STEP_EXECUTION_ID,
    ...rest,
  })({ result });
  return { commitPush, outcome };
}

async function runCommit(
  options: CommitOptions & { result?: AnyJsonValue },
  commitPush = new FakeGitCommitPushService(),
  submoduleService = new FakeSubmoduleService(),
) {
  return (await runCommitWithOutcome(options, commitPush, submoduleService))
    .commitPush;
}

describe("commit message", () => {
  test("defaults to boboddy: step <id> when no message is configured", async () => {
    const commitPush = await runCommit({});

    expect(commitPush.commitAllMessages).toEqual([DEFAULT_MESSAGE]);
  });

  test("defaults when the configured message is null", async () => {
    const commitPush = await runCommit({ message: null });

    expect(commitPush.commitAllMessages).toEqual([DEFAULT_MESSAGE]);
  });

  test("renders {{result.…}} and {{input.…}} tokens", async () => {
    const commitPush = await runCommit({
      message: "fix({{input.scope}}): {{result.summary}}",
      inputJson: { scope: "api" },
      result: { summary: "handle empty payloads" },
    });

    expect(commitPush.commitAllMessages).toEqual([
      "fix(api): handle empty payloads",
    ]);
  });

  test("falls back to the default when the template renders empty", async () => {
    const commitPush = await runCommit({
      message: "{{result.summary}}",
      result: { other: "x" },
    });

    expect(commitPush.commitAllMessages).toEqual([DEFAULT_MESSAGE]);
  });

  test("falls back to the default when only whitespace and control characters remain", async () => {
    const commitPush = await runCommit({
      message: "{{result.summary}}",
      result: { summary: " \u0000\t\n\u0007 " },
    });

    expect(commitPush.commitAllMessages).toEqual([DEFAULT_MESSAGE]);
  });

  test("strips control characters (NUL included) and collapses newlines to one line", async () => {
    const commitPush = await runCommit({
      message: "fix: {{result.summary}}",
      result: { summary: "a\u0000b\u001b[31mred\r\nsecond\tline\u007f" },
    });

    expect(commitPush.commitAllMessages).toEqual([
      "fix: ab[31mred second line",
    ]);
  });

  test("truncates the subject to 200 characters", async () => {
    const commitPush = await runCommit({
      message: "{{result.summary}}",
      result: { summary: "x".repeat(MAX_COMMIT_SUBJECT_LENGTH + 100) },
    });

    expect(commitPush.commitAllMessages).toEqual([
      "x".repeat(MAX_COMMIT_SUBJECT_LENGTH),
    ]);
  });

  test("does not split a surrogate pair when truncating", async () => {
    const commitPush = await runCommit({
      message: "{{result.summary}}",
      result: { summary: "\u{1F600}".repeat(MAX_COMMIT_SUBJECT_LENGTH + 5) },
    });

    expect(commitPush.commitAllMessages).toEqual([
      "\u{1F600}".repeat(MAX_COMMIT_SUBJECT_LENGTH),
    ]);
  });

  test("the same rendered message goes to the superproject and to submodules", async () => {
    const commitPush = new FakeGitCommitPushService();
    commitPush.submoduleHasChanges = () => Promise.resolve(true);

    await runCommit(
      { message: "chore: {{result.summary}}", result: { summary: "bump" } },
      commitPush,
      new FakeSubmoduleService([{ path: "vendor/dep", initialized: true }]),
    );

    expect(commitPush.submoduleCommitMessages).toEqual(["chore: bump"]);
    expect(commitPush.commitAllMessages).toEqual(["chore: bump"]);
  });
});

describe("onPushFailure", () => {
  function failingPush() {
    const commitPush = new FakeGitCommitPushService();
    commitPush.push = () =>
      Promise.reject(new Error("remote rejected: denied"));
    return commitPush;
  }

  test("throws a WorkBranchPushError naming the branch and the git error by default", async () => {
    const failure = await captureRejection(runCommit({}, failingPush()));

    expect(failure).toBeInstanceOf(WorkBranchPushError);
    expect((failure as WorkBranchPushError).workBranch).toBe(WORK_BRANCH);
    expect(failure.message).toContain(WORK_BRANCH);
    expect(failure.message).toContain("remote rejected: denied");
  });

  test('throws under an explicit "fail"', async () => {
    const failure = await captureRejection(
      runCommit({ onPushFailure: "fail" }, failingPush()),
    );

    expect(failure).toBeInstanceOf(WorkBranchPushError);
  });

  test('is swallowed under "warn"', async () => {
    const commitPush = await runCommit(
      { onPushFailure: "warn" },
      failingPush(),
    );

    expect(commitPush.commitAllMessages).toEqual([DEFAULT_MESSAGE]);
  });

  test('reports pushed: false when the push fails under "warn"', async () => {
    const { outcome } = await runCommitWithOutcome(
      { onPushFailure: "warn" },
      failingPush(),
    );

    expect(outcome).toEqual({ pushed: false });
  });

  test("reports pushed: true when the push succeeds", async () => {
    const { outcome } = await runCommitWithOutcome({ onPushFailure: "warn" });

    expect(outcome).toEqual({ pushed: true });
  });

  test("commits before the push is attempted, so a failure leaves the commit in place", async () => {
    const commitPush = failingPush();

    await runCommit({}, commitPush).catch(() => undefined);

    expect(commitPush.commitAllCalls).toBe(1);
  });
});

describe("submodule push failure", () => {
  function submoduleWithBrokenPush() {
    const commitPush = new FakeGitCommitPushService();
    commitPush.submoduleHasChanges = () => Promise.resolve(true);
    commitPush.pushSubmodule = () =>
      Promise.reject(new Error("submodule origin unreachable"));
    const submodules = new FakeSubmoduleService([
      { path: "vendor/dep", initialized: true },
    ]);
    return { commitPush, submodules };
  }

  test("throws by default, names the branch and submodule, and commits nothing", async () => {
    const { commitPush, submodules } = submoduleWithBrokenPush();

    const failure = await captureRejection(
      runCommit({}, commitPush, submodules),
    );

    expect(failure).toBeInstanceOf(WorkBranchPushError);
    expect((failure as WorkBranchPushError).submodulePath).toBe("vendor/dep");
    expect(failure.message).toContain(WORK_BRANCH);
    expect(failure.message).toContain("vendor/dep");
    expect(failure.message).toContain("submodule origin unreachable");
    expect(commitPush.commitAllCalls).toBe(0);
    expect(commitPush.pushCalls).toEqual([]);
  });

  test('throws under an explicit "fail"', async () => {
    const { commitPush, submodules } = submoduleWithBrokenPush();

    const failure = await captureRejection(
      runCommit({ onPushFailure: "fail" }, commitPush, submodules),
    );

    expect(failure).toBeInstanceOf(WorkBranchPushError);
  });

  test('under "warn" continues, pushes the superproject, and excludes the failed gitlink', async () => {
    const { commitPush, submodules } = submoduleWithBrokenPush();

    const { outcome } = await runCommitWithOutcome(
      { onPushFailure: "warn" },
      commitPush,
      submodules,
    );

    expect(commitPush.commitAllExcludePaths).toEqual([
      [...WORK_BRANCH_EXCLUDE_PATHS, "vendor/dep"],
    ]);
    expect(commitPush.pushCalls).toEqual([WORK_BRANCH]);
    expect(outcome).toEqual({ pushed: true });
  });
});
