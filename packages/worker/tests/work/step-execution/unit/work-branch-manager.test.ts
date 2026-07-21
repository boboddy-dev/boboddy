/**
 * Unit tests for `buildWorkBranchName`: the work-branch naming, including the
 * configurable `branchPrefix` (from the repo's `.boboddy/boboddy.jsonc`) and
 * its default/fallback behavior.
 */
import { describe, expect, test } from "bun:test";
import { buildWorkBranchName } from "../../../../src/work/step-execution/infra/work-branch-manager";

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
