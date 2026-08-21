import { describe, expect } from "bun:test";
import { assignedPipelineSchema } from "../src/lib/design-run-adapters";
import { concurrentTest as test } from "./utils";

/**
 * `assignedPipelineSchema` is the only thing pinning how the run offer finds the
 * pipeline to run. The generated SDK types a project's `defaultPipelineAssignment`
 * as `T | unknown`, which TypeScript collapses to plain `unknown`, so the compiler
 * cannot catch a wrong field name here — and a wrong read fails open: the offer
 * would silently decide "no pipeline is assigned" and never appear.
 *
 * These tests are that missing type check.
 */

describe("assignedPipelineSchema", () => {
  test("reads the assigned pipeline definition id", () => {
    const parsed = assignedPipelineSchema.safeParse({
      pipelineDefinitionId: "019ed1c9-2222-7170-a08a-1ff912085f7b",
      defaultEventType: "assign",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.pipelineDefinitionId).toBe(
      "019ed1c9-2222-7170-a08a-1ff912085f7b",
    );
  });

  test("rejects a project with no assignment", () => {
    // The field is nullable server-side: a project without a default pipeline.
    expect(assignedPipelineSchema.safeParse(null).success).toBe(false);
    expect(assignedPipelineSchema.safeParse(undefined).success).toBe(false);
  });

  test("rejects an assignment whose id is missing or empty", () => {
    expect(
      assignedPipelineSchema.safeParse({ defaultEventType: "assign" }).success,
    ).toBe(false);
    expect(
      assignedPipelineSchema.safeParse({ pipelineDefinitionId: "" }).success,
    ).toBe(false);
  });
});
