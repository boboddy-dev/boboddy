import { describe, expect, test } from "bun:test";
import { resolveFirstStepDefinitionId } from "../../../../src/work/step-execution/application/run-pipeline-first-step-dry-run";
import { ConfigurationError } from "../../../../src/lib/errors";

/**
 * `resolveFirstStepDefinitionId` is the one thing standing between "pipeline
 * id" and "ambiguous step id" (#146): it has to pick the same first step a
 * real execution would run, regardless of what order the server happened to
 * return the list in.
 */

describe("resolveFirstStepDefinitionId", () => {
  test("picks the step with the lowest position", () => {
    const stepDefinitionId = resolveFirstStepDefinitionId("pipeline-1", [
      { stepDefinitionId: "step-b", position: 2 },
      { stepDefinitionId: "step-a", position: 1 },
      { stepDefinitionId: "step-c", position: 3 },
    ]);

    expect(stepDefinitionId).toBe("step-a");
  });

  test("does not depend on response order", () => {
    const alreadyOrdered = resolveFirstStepDefinitionId("pipeline-1", [
      { stepDefinitionId: "step-a", position: 1 },
      { stepDefinitionId: "step-b", position: 2 },
    ]);
    const reversed = resolveFirstStepDefinitionId("pipeline-1", [
      { stepDefinitionId: "step-b", position: 2 },
      { stepDefinitionId: "step-a", position: 1 },
    ]);

    expect(alreadyOrdered).toBe(reversed);
  });

  test("a single-step pipeline resolves to that step", () => {
    expect(
      resolveFirstStepDefinitionId("pipeline-1", [
        { stepDefinitionId: "only-step", position: 1 },
      ]),
    ).toBe("only-step");
  });

  test("throws a ConfigurationError for a pipeline with no steps", () => {
    expect(() => resolveFirstStepDefinitionId("pipeline-1", [])).toThrow(
      ConfigurationError,
    );
  });
});
