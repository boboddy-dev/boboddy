import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  pipeline,
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

describe("pipeline() builder — .advance() (Phase 4)", () => {
  test.concurrent("all-group with route outcome serializes correctly", () => {
    const spec = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      .advance(({ signal, all, route }) => ({
        default: "complete",
        rules: [
          all(
            signal("success").eq(true),
            signal("repro_url").eq("https://x"),
          ).then(route("downstream", { ok: true })),
        ],
      }))
      .build();

    const step0 = spec.steps[0];
    if (!step0) throw new Error("expected step0");
    const rule = step0.advancementPolicyDefinition.rulesJson.rules[0];
    if (!rule) throw new Error("expected rule");
    expect(rule.conditions).toMatchObject({
      all: [
        { fact: "success", operator: "equal", value: true },
        { fact: "repro_url", operator: "equal", value: "https://x" },
      ],
    });
    expect(rule.event).toMatchObject({
      type: "route",
      params: { pipelineKey: "downstream", inputJson: { ok: true } },
    });
  });

  test.concurrent(
    "computed rule (avg) hoists into computedSignalDefinitions",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        // eslint-disable-next-line @typescript-eslint/unbound-method
        .advance(({ avg, stepSignals }) => ({
          default: "complete",
          rules: [
            avg(stepSignals.score, stepSignals.score2)
              .gte(0.5)
              .then("continue"),
          ],
        }))
        .build();

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      expect(step0.computedSignalDefinitions).toEqual([
        {
          key: "average_score_score2",
          type: "average",
          inputSignalKeys: ["score", "score2"],
          configJson: null,
          availableWhenResultStatusIn: null,
        },
      ]);
      expect(
        step0.advancementPolicyDefinition.rulesJson.rules[0],
      ).toMatchObject({
        conditions: {
          all: [
            {
              fact: "average_score_score2",
              operator: "greaterThanInclusive",
              value: 0.5,
            },
          ],
        },
        event: { type: "continue" },
      });
    },
  );

  test.concurrent(
    "stepSignals property map produces same condition as signal()",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(({ stepSignals }) => ({
          default: "block",
          rules: [stepSignals.success.eq(true).then("continue")],
        }))
        .build();

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      expect(
        step0.advancementPolicyDefinition.rulesJson.rules[0],
      ).toMatchObject({
        conditions: {
          all: [{ fact: "success", operator: "equal", value: true }],
        },
        event: { type: "continue" },
      });
    },
  );

  test.concurrent("multi-step pipeline with .advance() on each step", () => {
    const fromBuilder = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      .advance(({ signal }) => ({
        default: "block",
        rules: [signal("success").eq(true).then("continue")],
      }))
      .step(verifyStep, ({ signal, output }) => ({
        reproUrl: signal(reproduceStep, "repro_url"),
        checkSuccess: signal(reproduceStep, "success"),
        fullPrior: output(reproduceStep),
      }))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      .advance(({ signal }) => ({
        default: "complete",
        rules: [signal("passed").eq(true).then("continue")],
      }))
      .build();

    expect(fromBuilder.steps).toHaveLength(2);
    const fbStep0 = fromBuilder.steps[0];
    if (!fbStep0) throw new Error("expected fbStep0");
    const fbStep1 = fromBuilder.steps[1];
    if (!fbStep1) throw new Error("expected fbStep1");
    expect(fbStep0.advancementPolicyDefinition.defaultEventType).toBe("block");
    expect(fbStep1.advancementPolicyDefinition.defaultEventType).toBe("complete");
    const fbRule0 = fbStep0.advancementPolicyDefinition.rulesJson.rules[0];
    if (!fbRule0) throw new Error("expected fbRule0");
    expect(fbRule0.conditions).toMatchObject({
      all: [{ fact: "success", operator: "equal", value: true }],
    });
    const fbRule1 = fbStep1.advancementPolicyDefinition.rulesJson.rules[0];
    if (!fbRule1) throw new Error("expected fbRule1");
    expect(fbRule1.conditions).toMatchObject({
      all: [{ fact: "passed", operator: "equal", value: true }],
    });
  });
});

