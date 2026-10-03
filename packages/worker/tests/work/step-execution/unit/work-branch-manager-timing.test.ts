/**
 * `prepareWorkBranch` reports how long preparing the work branch took through
 * the work logger, at info level so it ships in the step log.
 */
import { describe, expect, test } from "bun:test";
import { prepareWorkBranch } from "../../../../src/work/step-execution/infra/work-branch-manager";
import { createRecordingWorkLogger } from "../../../support/recording-work-logger";
import { FakeGitCommitPushService } from "./helpers/orchestrator-launch-fakes";

const STEP_EXECUTION_ID = "0192f000-0000-7000-8000-000000000000";
const PREPARED_LINE = /^work branch prepared in \d+\.\ds$/u;

function buildInput(baseWorkBranch: string | null) {
  return {
    gitCommitPushService: new FakeGitCommitPushService(),
    workspacePath: "/tmp/workspace",
    resolvedBranch: "main",
    baseWorkBranch,
    stepKey: "build",
    stepExecutionId: STEP_EXECUTION_ID,
  };
}

describe("prepareWorkBranch timing", () => {
  test.concurrent("logs its duration at info level", async () => {
    const { entries, logger } = createRecordingWorkLogger();

    await prepareWorkBranch({ ...buildInput(null), logger });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("log");
    expect(entries[0]?.scope).toBe("runtime");
    expect(entries[0]?.message).toMatch(PREPARED_LINE);
  });

  test.concurrent("includes the base checkout in the timed span", async () => {
    const { entries, logger } = createRecordingWorkLogger();

    await prepareWorkBranch({ ...buildInput("feature/base"), logger });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toMatch(PREPARED_LINE);
  });

  test.concurrent("logs nothing when it fails", async () => {
    const { entries, logger } = createRecordingWorkLogger();
    const input = buildInput("feature/base");
    input.gitCommitPushService.checkoutBase = () =>
      Promise.reject(new Error("checkout failed"));

    const outcome = await prepareWorkBranch({ ...input, logger }).then(
      () => "resolved",
      () => "rejected",
    );

    expect(outcome).toBe("rejected");
    expect(entries).toEqual([]);
  });

  test.concurrent("works without a logger", async () => {
    const prepared = await prepareWorkBranch(buildInput(null));

    expect(prepared.createdFromBranch).toBe("main");
  });
});
