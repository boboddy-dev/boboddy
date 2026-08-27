import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { pipeline } from "../src/definitions/pipelines/builder";
import { defaultPipelineAssignment } from "../src/definitions/pipelines/define-default-pipeline-assignment";
import { defineStep } from "../src/definitions/steps/define-step";

const triageStep = defineStep({
  key: "triage",
  name: "Triage",
  agentPrompt: "Triage the incoming work item.",
  result: z.object({ ok: z.boolean() }),
  signals: [{ sourcePath: "ok" }],
});

const triagePipeline = pipeline({ key: "triage-and-plan", name: "Triage and Plan" })
  .step(triageStep, {
    advance: () => ({ default: "continue" }),
  })
  .build();

describe("defaultPipelineAssignment / assign()", () => {
  test.concurrent("assign() accepts a real pipeline().build() output", () => {
    const spec = defaultPipelineAssignment(({ assign }) => ({
      default: assign(triagePipeline),
      rules: [],
    }));

    expect(spec.default).toEqual({ _tag: "assign", pipeline: triagePipeline });
  });

  test.concurrent("assign() rejects a non-pipeline value", () => {
    expect(() =>
      defaultPipelineAssignment(({ assign }) => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        default: assign({ key: "not-a-pipeline" } as any),
        rules: [],
      })),
    ).toThrow(/assign\(\) requires a pipeline spec produced by pipeline\(\)\.build\(\)/);
  });

  test.concurrent("assign() works inside a rule's .then()", () => {
    const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => ({
      default: skip(),
      rules: [
        workItem.field("issueType").eq("bug").then(assign(triagePipeline)),
      ],
    }));

    expect(spec.rules[0]?.outcome).toEqual({
      _tag: "assign",
      pipeline: triagePipeline,
    });
  });
});
