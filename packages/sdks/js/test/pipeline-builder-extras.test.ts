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

describe("pipeline() builder — parity coverage (Phase 5) — advancement", () => {
  test.concurrent('defaultOutcome "block" serializes correctly', () => {
    const spec = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      .advance(() => ({ default: "block" }))
      .build();

    const step0 = spec.steps[0];
    if (!step0) throw new Error("expected step0");
    expect(step0.advancementPolicyDefinition).toMatchObject({
      defaultEventType: "block",
      allowedEventTypes: ["block"],
    });
  });

  test.concurrent("top-level .any() produces an any-mode rule", () => {
    const spec = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      .advance(({ signal, any }) => ({
        default: "block",
        rules: [
          any(
            signal("success").eq(true),
            signal("repro_url").contains("localhost"),
          ).then("continue"),
        ],
      }))
      .build();

    const step0 = spec.steps[0];
    if (!step0) throw new Error("expected step0");
    const rule0 = step0.advancementPolicyDefinition.rulesJson.rules[0];
    if (!rule0) throw new Error("expected rule0");
    const cond = rule0.conditions as {
      any: { fact: string; operator: string; value: unknown }[];
    };
    expect(cond.any).toEqual([
      { fact: "success", operator: "equal", value: true },
      { fact: "repro_url", operator: "contains", value: "localhost" },
    ]);
  });

  test.concurrent("multiple rules per step are preserved in order", () => {
    const spec = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      .advance(({ signal }) => ({
        default: "block",
        rules: [
          signal("success").eq(true).then("continue"),
          signal("repro_url").eq("").then("block"),
        ],
      }))
      .build();

    const step0 = spec.steps[0];
    if (!step0) throw new Error("expected step0");
    const rules = step0.advancementPolicyDefinition.rulesJson.rules;
    expect(rules).toHaveLength(2);
    const rule0 = rules[0];
    if (!rule0) throw new Error("expected rule0");
    const rule1 = rules[1];
    if (!rule1) throw new Error("expected rule1");
    expect(rule0.event.type).toBe("continue");
    expect(rule1.event.type).toBe("block");
  });

  test.concurrent(
    "allowedEventTypes contains the default outcome plus every rule outcome",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        // eslint-disable-next-line @typescript-eslint/unbound-method
        .advance(({ signal, route }) => ({
          default: "block",
          rules: [
            signal("success").eq(true).then("continue"),
            signal("repro_url").eq("").then(route("downstream")),
          ],
        }))
        .build();

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      expect(
        step0.advancementPolicyDefinition.allowedEventTypes,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      ).toEqual(expect.arrayContaining(["block", "continue", "route"]));
    },
  );
});

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
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance((ctx) => ({
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
        }))
        .build();

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      const defs = step0.computedSignalDefinitions;
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
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance((ctx) => ({
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
        }))
        .build();

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      const defs = step0.computedSignalDefinitions;
      expect(defs).toHaveLength(1);
      expect(defs[0]).toMatchObject({
        type: wireType,
        inputSignalKeys: ["success", "verified"],
      });
    },
  );

  test.concurrent("same computed token across rules is deduped", () => {
    const spec = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      .advance(({ sum, stepSignals }) => ({
        default: "block",
        rules: [
          sum(stepSignals.score, stepSignals.score2).eq(1).then("continue"),
          sum(stepSignals.score, stepSignals.score2).eq(0).then("block"),
        ],
      }))
      .build();

    const step0 = spec.steps[0];
    if (!step0) throw new Error("expected step0");
    expect(step0.computedSignalDefinitions).toHaveLength(1);
    const computedDef0 = step0.computedSignalDefinitions[0];
    if (!computedDef0) throw new Error("expected computedDef0");
    expect(computedDef0.key).toBe("sum_score_score2");
  });

  test.concurrent(
    "computed nested inside all/any groups is still extracted",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        // eslint-disable-next-line @typescript-eslint/unbound-method
        .advance(({ all, any, max, min, signal, stepSignals }) => ({
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
        }))
        .build();

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      const keys = step0.computedSignalDefinitions.map(
        (d) => d.key,
      ).sort();
      expect(keys).toEqual(["max_score_score2", "min_score_score2"]);
    },
  );
});

describe("pipeline() builder — parity coverage (Phase 5) — timeout and end-to-end", () => {
  describe("timeout", () => {
    test.concurrent("timeoutSeconds defaults to null when omitted", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      expect(step0.timeoutSeconds).toBeNull();
    });

    test.concurrent("config callback sets timeoutSeconds on the step", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(
          reproduceStep,
          ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }),
          (cfg) => {
            cfg.timeout = 900;
          },
        )
        .advance(() => ({ default: "continue" }))
        .build();

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      expect(step0.timeoutSeconds).toBe(900);
    });
  });

  describe("end-to-end", () => {
    test.concurrent(
      "representative non-trivial pipeline produces correct spec",
      () => {
        const spec = pipeline({
          key: "ticket-router",
          name: "Ticket Router",
          description: "scores then routes",
        })
          .step(
            reproduceStep,
            ({ input }) => ({
              title: input.workItemTitle,
              description: input.workItemDescription,
            }),
            (cfg) => {
              cfg.timeout = 300;
            },
          )
          // eslint-disable-next-line @typescript-eslint/unbound-method
          .advance(({ avg, signal, stepSignals }) => ({
            default: "complete",
            rules: [
              avg(stepSignals.score, stepSignals.score2)
                .gte(0.8)
                .then("continue"),
              signal("success").eq(false).then("block"),
            ],
          }))
          .step(verifyStep, ({ signal, output }) => ({
            reproUrl: signal(reproduceStep, "repro_url"),
            checkSuccess: signal(reproduceStep, "success"),
            fullPrior: output(reproduceStep),
          }))
          // eslint-disable-next-line @typescript-eslint/unbound-method
          .advance(({ signal, all, route }) => ({
            default: "complete",
            rules: [
              all(signal("passed").eq(true)).then(
                route("downstream", { ok: true }),
              ),
              signal("passed").eq(false).then("block"),
            ],
          }))
          .build();

        expect(spec.key).toBe("ticket-router");
        expect(spec.description).toBe("scores then routes");
        expect(spec.steps).toHaveLength(2);

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.stepKey).toBe("reproduce");
        expect(step0.timeoutSeconds).toBe(300);
        expect(step0.inputBindingsJson).toMatchObject({
          title: { source: "work_item", field: "title" },
          description: { source: "work_item", field: "description" },
        });
        expect(step0.advancementPolicyDefinition.defaultEventType).toBe(
          "complete",
        );
        expect(step0.advancementPolicyDefinition.rulesJson.rules).toHaveLength(
          2,
        );
        expect(step0.computedSignalDefinitions).toHaveLength(1);

        const step1 = spec.steps[1];
        if (!step1) throw new Error("expected step1");
        expect(step1.stepKey).toBe("verify");
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
        expect(step1.advancementPolicyDefinition.rulesJson.rules).toHaveLength(
          2,
        );
      },
    );
  });
});
