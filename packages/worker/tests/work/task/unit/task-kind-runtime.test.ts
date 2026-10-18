/**
 * Typing the table as `Record<TaskKind, boolean>` makes a newly added kind
 * fail typecheck here until it is classified; the loop below then asserts
 * `taskKindUsesAgent` agrees with that classification for every kind.
 */
import { describe, expect, test } from "bun:test";
import { taskKindUsesAgent } from "../../../../src/work/task/application/task-kind-runtime";
import type { TaskKind } from "../../../../src/work/task/contracts/task-contracts";

const expectedUsesAgent: Record<TaskKind, boolean> = {
  agent: true,
  code: false,
};

const kinds = Object.keys(expectedUsesAgent) as TaskKind[];

describe("taskKindUsesAgent", () => {
  test.each(kinds)("classifies '%s' as expected", (kind) => {
    expect(taskKindUsesAgent(kind)).toBe(expectedUsesAgent[kind]);
  });

  test("only agent tasks start the agent", () => {
    expect(kinds.filter(taskKindUsesAgent)).toEqual(["agent"]);
  });
});
