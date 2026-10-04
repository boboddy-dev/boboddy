/**
 * Typing the table as `Record<StepDefinitionKind, boolean>` makes a newly added
 * kind fail typecheck here until it is classified; the loop below then asserts
 * `stepKindUsesAgent` agrees with that classification for every kind.
 */
import { describe, expect, test } from "bun:test";
import { stepKindUsesAgent } from "../../../../src/work/step-execution/application/step-kind-runtime";
import type { StepDefinitionKind } from "../../../../src/work/step-execution/contracts/step-execution-contracts";

const expectedUsesAgent: Record<StepDefinitionKind, boolean> = {
  built_in: true,
  user_defined: true,
  code: false,
};

const kinds = Object.keys(expectedUsesAgent) as StepDefinitionKind[];

describe("stepKindUsesAgent", () => {
  test.each(kinds)("classifies '%s' as expected", (kind) => {
    expect(stepKindUsesAgent(kind)).toBe(expectedUsesAgent[kind]);
  });

  test("only prompt-driven kinds start the agent", () => {
    expect(kinds.filter(stepKindUsesAgent).sort()).toEqual([
      "built_in",
      "user_defined",
    ]);
  });
});
