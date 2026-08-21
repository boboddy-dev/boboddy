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
      .step(reproduceStep, {
        input: ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }),
        advance: () => ({ default: "block" }),
      })
      .build();

    const step0 = spec.nodeDefinitions[0];
    if (!step0) throw new Error("expected step0");
    expect(
      requireDefined(
        step0.advancementPolicyDefinition,
        "advancementPolicyDefinition",
      ),
    ).toMatchObject({
      defaultEventType: "block",
      allowedEventTypes: ["block"],
    });
  });

  test.concurrent("top-level .any() produces an any-mode rule", () => {
    const spec = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, {
        input: ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }),
        // eslint-disable-next-line @typescript-eslint/unbound-method
        advance: ({ signal, any }) => ({
          default: "block",
          rules: [
            any(
              signal("success").eq(true),
              signal("repro_url").contains("localhost"),
            ).then("continue"),
          ],
        }),
      })
      .build();

    const step0 = spec.nodeDefinitions[0];
    if (!step0) throw new Error("expected step0");
    const policy0 = requireDefined(
      step0.advancementPolicyDefinition,
      "advancementPolicyDefinition",
    );
    const rule0 = policy0.rulesJson.rules[0];
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
      .step(reproduceStep, {
        input: ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }),
        // eslint-disable-next-line @typescript-eslint/unbound-method
        advance: ({ signal }) => ({
          default: "block",
          rules: [
            signal("success").eq(true).then("continue"),
            signal("repro_url").eq("").then("block"),
          ],
        }),
      })
      .build();

    const step0 = spec.nodeDefinitions[0];
    if (!step0) throw new Error("expected step0");
    const rules = requireDefined(
      step0.advancementPolicyDefinition,
      "advancementPolicyDefinition",
    ).rulesJson.rules;
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
        .step(reproduceStep, {
          input: ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }),
          // eslint-disable-next-line @typescript-eslint/unbound-method
          advance: ({ signal, route }) => ({
            default: "block",
            rules: [
              signal("success").eq(true).then("continue"),
              signal("repro_url").eq("").then(route("downstream")),
            ],
          }),
        })
        .build();

      const step0 = spec.nodeDefinitions[0];
      if (!step0) throw new Error("expected step0");
      const policy = requireDefined(
        step0.advancementPolicyDefinition,
        "advancementPolicyDefinition",
      );
      expect(
        policy.allowedEventTypes,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      ).toEqual(expect.arrayContaining(["block", "continue", "route"]));
    },
  );
});

describe("pipeline() builder — parity coverage (Phase 5) — timeout and end-to-end", () => {
  describe("timeout", () => {
    test.concurrent("timeoutSeconds defaults to null when omitted", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, {
          input: ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }),
          advance: () => ({ default: "continue" }),
        })
        .build();

      const step0 = spec.nodeDefinitions[0];
      if (!step0) throw new Error("expected step0");
      expect(step0.timeoutSeconds).toBeNull();
    });

    test.concurrent("options.timeout sets timeoutSeconds on the step", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, {
          input: ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }),
          advance: () => ({ default: "continue" }),
          timeout: 900,
        })
        .build();

      const step0 = spec.nodeDefinitions[0];
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
          .step(reproduceStep, {
            input: ({ input }) => ({
              title: input.workItemTitle,
              description: input.workItemDescription,
            }),
            timeout: 300,
            // eslint-disable-next-line @typescript-eslint/unbound-method
            advance: ({ avg, signal, stepSignals }) => ({
              default: "complete",
              rules: [
                avg(stepSignals.score, stepSignals.score2)
                  .gte(0.8)
                  .then("continue"),
                signal("success").eq(false).then("block"),
              ],
            }),
          })
          .step(verifyStep, {
            input: ({ signal, output }) => ({
              reproUrl: signal(reproduceStep, "repro_url"),
              checkSuccess: signal(reproduceStep, "success"),
              fullPrior: output(reproduceStep),
            }),
            // eslint-disable-next-line @typescript-eslint/unbound-method
            advance: ({ signal, all, route }) => ({
              default: "complete",
              rules: [
                all(signal("passed").eq(true)).then(
                  route("downstream", { ok: true }),
                ),
                signal("passed").eq(false).then("block"),
              ],
            }),
          })
          .build();

        expect(spec.key).toBe("ticket-router");
        expect(spec.description).toBe("scores then routes");
        expect(spec.nodeDefinitions).toHaveLength(2);

        const step0 = spec.nodeDefinitions[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.stepKey).toBe("reproduce");
        expect(step0.timeoutSeconds).toBe(300);
        expect(step0.inputBindingsJson).toMatchObject({
          title: { source: "work_item", field: "title" },
          description: { source: "work_item", field: "description" },
        });
        const step0Policy = requireDefined(
          step0.advancementPolicyDefinition,
          "advancementPolicyDefinition",
        );
        expect(step0Policy.defaultEventType).toBe("complete");
        expect(step0Policy.rulesJson.rules).toHaveLength(2);
        expect(
          requireDefined(
            step0.computedSignalDefinitions,
            "computedSignalDefinitions",
          ),
        ).toHaveLength(1);

        const step1 = spec.nodeDefinitions[1];
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
        expect(
          requireDefined(
            step1.advancementPolicyDefinition,
            "advancementPolicyDefinition",
          ).rulesJson.rules,
        ).toHaveLength(2);
      },
    );
  });
});
