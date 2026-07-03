import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  pipeline,
  PipelineBuilder,
  PipelineStepAdvancementBuilder,
  PipelineStepBuilder,
} from "../src/definitions/pipelines/builder";
import { defineStep } from "../src/definitions/steps/define-step";

const reproduceStep = defineStep({
  key: "reproduce",
  name: "Reproduce Issue",
  agentPrompt:
    "Reproduce the following issue using the provided title and description.",
  additionalInput: z.object({ title: z.string(), description: z.string() }),
  result: z.object({
    url: z.string(),
    success: z.boolean(),
    verified: z.boolean(),
    score: z.number(),
    score2: z.number(),
  }),
  signals: [
    { sourcePath: "url", key: "repro_url" },
    { sourcePath: "success" },
    { sourcePath: "verified" },
    { sourcePath: "score" },
    { sourcePath: "score2" },
  ],
});

const verifyStep = defineStep({
  key: "verify",
  name: "Verify Fix",
  agentPrompt: "Verify whether the fix passes using the provided inputs.",
  result: z.object({ passed: z.boolean() }),
  signals: [{ sourcePath: "passed" }],
});

describe("pipeline() builder — Phase 1", () => {
  test.concurrent("pipeline() returns a PipelineBuilder", () => {
    const builder = pipeline({ key: "p", name: "P" });

    expect(builder).toBeInstanceOf(PipelineBuilder);
  });

  test.concurrent(
    "build() carries explicit description, version, status",
    () => {
      const spec = pipeline({
        key: "p",
        name: "P",
        description: "does stuff",
        version: 3,
        status: "draft",
      })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      expect(spec.description).toBe("does stuff");
      expect(spec.version).toBe(3);
      expect(spec.status).toBe("draft");
    },
  );
});

describe("pipeline() builder — .step() (Phase 3)", () => {
  test.concurrent(".step() returns a PipelineStepAdvancementBuilder", () => {
    const builder = pipeline({ key: "p", name: "P" }).step(
      reproduceStep,
      ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }),
    );

    expect(builder).toBeInstanceOf(PipelineStepAdvancementBuilder);
  });

  test.concurrent(".advance() returns a PipelineStepBuilder", () => {
    const builder = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      .advance(() => ({ default: "continue" }));

    expect(builder).toBeInstanceOf(PipelineStepBuilder);
  });

  test.concurrent(
    "multi-step pipeline: signal and output bindings serialize correctly",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .step(verifyStep, ({ signal, output }) => ({
          reproUrl: signal(reproduceStep, "repro_url"),
          checkSuccess: signal(reproduceStep, "success"),
          fullPrior: output(reproduceStep),
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      const step1 = spec.steps[1];
      if (!step1) throw new Error("expected step1");
      expect(step1.inputBindingsJson).toMatchObject({
        reproUrl: {
          source: "step_signal",
          stepKey: "reproduce",
          signalKey: "repro_url",
        },
        checkSuccess: {
          source: "step_signal",
          stepKey: "reproduce",
          signalKey: "success",
        },
        fullPrior: { source: "step_output", stepKey: "reproduce" },
      });
    },
  );

  test.concurrent(
    "_stepDefinitions accumulates referenced step specs deduped",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .step(verifyStep, ({ signal, output }) => ({
          reproUrl: signal(reproduceStep, "repro_url"),
          checkSuccess: signal(reproduceStep, "success"),
          fullPrior: output(reproduceStep),
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      const keys = (spec._stepDefinitions ?? []).map((s) => s.key);
      expect(keys.sort()).toEqual(["reproduce", "verify"]);
    },
  );
});
