import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { pipeline } from "../src/definitions/pipelines/builder";
import { defineStep } from "../src/definitions/steps/define-step";
import { requireDefined } from "./test-support";

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

/**
 * `pipeline() builder — parity coverage (Phase 5) — computed signals` —
 * split out of `pipeline-builder-extras.test.ts` to keep that file under
 * the repo's `max-lines` limit; see that file for the rest of the Phase 5
 * parity coverage.
 */
describe("pipeline() builder — parity coverage (Phase 5) — computed signals", () => {
  test.concurrent.each([
    ["avg", "average"],
    ["weightedAvg", "weighted_average"],
    ["sum", "sum"],
    ["min", "min"],
    ["max", "max"],
    ["count", "count"],
  ] as const)(
    "ctx.%s emits a computed signal of type %s",
    (factory, wireType) => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, {
          input: ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }),
          advance: (ctx) => ({
            default: "block",
            rules: [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
              (ctx[factory] as any)(
                ctx.stepSignals.score,
                ctx.stepSignals.score2,
              )
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                .eq(1)
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                .then("continue"),
            ],
          }),
        })
        .build();

      const step0 = spec.nodeDefinitions[0];
      if (!step0) throw new Error("expected step0");
      const defs = requireDefined(
        step0.computedSignalDefinitions,
        "computedSignalDefinitions",
      );
      expect(defs).toHaveLength(1);
      expect(defs[0]).toMatchObject({
        type: wireType,
        inputSignalKeys: ["score", "score2"],
      });
    },
  );

  test.concurrent.each([
    ["booleanAny", "boolean_any"],
    ["booleanAll", "boolean_all"],
  ] as const)(
    "ctx.%s emits a computed signal of type %s",
    (factory, wireType) => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, {
          input: ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }),
          advance: (ctx) => ({
            default: "block",
            rules: [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
              (ctx[factory] as any)(
                ctx.stepSignals.success,
                ctx.stepSignals.verified,
              )
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                .eq(true)
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                .then("continue"),
            ],
          }),
        })
        .build();

      const step0 = spec.nodeDefinitions[0];
      if (!step0) throw new Error("expected step0");
      const defs = requireDefined(
        step0.computedSignalDefinitions,
        "computedSignalDefinitions",
      );
      expect(defs).toHaveLength(1);
      expect(defs[0]).toMatchObject({
        type: wireType,
        inputSignalKeys: ["success", "verified"],
      });
    },
  );

  test.concurrent("same computed token across rules is deduped", () => {
    const spec = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, {
        input: ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }),
        // eslint-disable-next-line @typescript-eslint/unbound-method
        advance: ({ sum, stepSignals }) => ({
          default: "block",
          rules: [
            sum(stepSignals.score, stepSignals.score2).eq(1).then("continue"),
            sum(stepSignals.score, stepSignals.score2).eq(0).then("block"),
          ],
        }),
      })
      .build();

    const step0 = spec.nodeDefinitions[0];
    if (!step0) throw new Error("expected step0");
    const computedDefs = requireDefined(
      step0.computedSignalDefinitions,
      "computedSignalDefinitions",
    );
    expect(computedDefs).toHaveLength(1);
    const computedDef0 = computedDefs[0];
    if (!computedDef0) throw new Error("expected computedDef0");
    expect(computedDef0.key).toBe("sum_score_score2");
  });

  test.concurrent(
    "computed nested inside all/any groups is still extracted",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, {
          input: ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }),
          // eslint-disable-next-line @typescript-eslint/unbound-method
          advance: ({ all, any, max, min, signal, stepSignals }) => ({
            default: "block",
            rules: [
              all(
                max(stepSignals.score, stepSignals.score2).eq(10),
                any(
                  min(stepSignals.score, stepSignals.score2).eq(0),
                  signal("repro_url").contains("https"),
                ),
              ).then("continue"),
            ],
          }),
        })
        .build();

      const step0 = spec.nodeDefinitions[0];
      if (!step0) throw new Error("expected step0");
      const keys = requireDefined(
        step0.computedSignalDefinitions,
        "computedSignalDefinitions",
      )
        .map((d) => d.key)
        .sort();
      expect(keys).toEqual(["max_score_score2", "min_score_score2"]);
    },
  );
});
