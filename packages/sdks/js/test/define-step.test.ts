import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineStep } from "../src/definitions/steps/define-step";
import {
  Features,
  type AnyStepFeature,
} from "../src/definitions/steps/step-features";

describe("defineStep", () => {
  test("applies sensible defaults", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
    });
    expect(spec).toMatchObject({
      version: 1,
      kind: "user_defined",
      status: "active",
      description: null,
      prompt: "Do the work.",
      inputSchemaJson: null,
      resultSchemaJson: null,
      signalExtractorDefinitions: [],
      opencodeMcpJson: null,
      opencodePluginJson: null,
    });
  });

  test("supports function agent prompts with scoped prompt tokens", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      additionalInput: z.object({ title: z.string() }),
      agentPrompt: ({ input, env, boboddy }) =>
        `Open ${env.BASE_URL ?? ""} for ${input.title} and save artifacts to ${boboddy.artifactsDir}`,
    });

    expect(spec.prompt).toBe(
      "Open {{env.BASE_URL}} for {{input.title}} and save artifacts to {{boboddy.artifactsDir}}",
    );
  });

  test("converts a complex nested result schema to JSON Schema", () => {
    const resultSchema = z
      .object({
        outcome: z.enum([
          "reproduced",
          "not_reproducible",
          "needs_user_feedback",
          "agent_error",
          "cancelled",
        ]),
        summaryOfFindings: z.string().min(1),
        stepsTried: z.array(z.string().min(1)),
        observedBehavior: z.string().nullable().optional(),
        expectedBehavior: z.string().nullable().optional(),
        failureReason: z.string().nullable().optional(),
        rawResultJson: z.record(z.string(), z.unknown()).nullable().optional(),
        feedbackRequestsV1: z
          .array(
            z.object({
              question: z.string(),
              category: z.string(),
              suggestedKey: z.string(),
            }),
          )
          .optional(),
      })
      .loose();

    const spec = defineStep({
      key: "debug-issue",
      name: "Debug Issue",
      agentPrompt: "Analyze the issue.",
      result: resultSchema,
      signals: [{ sourcePath: "outcome" }, { sourcePath: "summaryOfFindings" }],
    });

    expect(spec.resultSchemaJson).toMatchObject({
      type: "object",

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      required: expect.arrayContaining([
        "outcome",
        "summaryOfFindings",
        "stepsTried",
      ]),
      properties: {
        outcome: {
          type: "string",
          enum: [
            "reproduced",
            "not_reproducible",
            "needs_user_feedback",
            "agent_error",
            "cancelled",
          ],
        },
        summaryOfFindings: { type: "string", minLength: 1 },
        stepsTried: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        feedbackRequestsV1: {
          type: "array",
          items: {
            type: "object",

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            required: expect.arrayContaining([
              "question",
              "category",
              "suggestedKey",
            ]),
            properties: {
              question: { type: "string" },
              category: { type: "string" },
              suggestedKey: { type: "string" },
            },
          },
        },
      },
    });
  });

  describe("features", () => {
    const mockFeatureA: AnyStepFeature = {
      _resultExtension: z.object({ flagA: z.boolean() }),
      _promptAddition: "Feature A instructions",
      _signals: [
        { key: "sig_a", sourcePath: "flagA", type: "boolean", required: true },
      ],
    };
    const mockFeatureB: AnyStepFeature = {
      _resultExtension: z.object({ labelB: z.string() }),
      _promptAddition: "Feature B instructions",
      _signals: [
        { key: "sig_b", sourcePath: "labelB", type: "string", required: false },
      ],
    };

    test("merges feature result extension into resultSchemaJson", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        result: z.object({ score: z.number() }),
        features: [mockFeatureA],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          score: { type: "number" },
          flagA: { type: "boolean" },
        },
      });
    });

    test("builds resultSchemaJson from feature alone when no base result schema", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        features: [mockFeatureA],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: { flagA: { type: "boolean" } },
      });
    });

    test("appends feature prompt addition to the base agent prompt", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        features: [mockFeatureA],
      });

      expect(spec.prompt).toBe("Do the work.\n\nFeature A instructions");
    });

    test("appends feature prompt addition to existing prompt with double newline separator", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Base prompt.",
        features: [mockFeatureA],
      });

      expect(spec.prompt).toBe("Base prompt.\n\nFeature A instructions");
    });

    test("appends feature prompt additions after function prompt normalization", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        additionalInput: z.object({ title: z.string() }),
        agentPrompt: ({ input }) => `Use ${input.title}.`,
        features: [mockFeatureA],
      });

      expect(spec.prompt).toBe(
        "Use {{input.title}}.\n\nFeature A instructions",
      );
    });

    test("injects feature signals into signalExtractorDefinitions", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        features: [mockFeatureA],
      });

      expect(spec.signalExtractorDefinitions).toEqual([
        {
          key: "sig_a",
          sourcePath: "flagA",
          type: "boolean",
          required: true,
          availableWhenResultStatusIn: null,
        },
      ]);
    });

    test("feature signals are appended after user-defined signals", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        result: z.object({ score: z.number(), flagA: z.boolean() }),
        signals: [{ sourcePath: "score" }],
        features: [mockFeatureA],
      });

      const defs = spec.signalExtractorDefinitions;
      expect(defs).toHaveLength(2);
      const def0 = defs[0];
      if (!def0) throw new Error("expected def0");
      expect(def0.key).toBe("score");
      const def1 = defs[1];
      if (!def1) throw new Error("expected def1");
      expect(def1.key).toBe("sig_a");
    });

    test("multiple features merge all result extensions, prompts, and signals", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        features: [mockFeatureA, mockFeatureB],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          flagA: { type: "boolean" },
          labelB: { type: "string" },
        },
      });
      expect(spec.prompt).toBe(
        "Do the work.\n\nFeature A instructions\n\nFeature B instructions",
      );
      const defs = spec.signalExtractorDefinitions;
      expect(defs).toHaveLength(2);
      const sigA = defs[0];
      if (!sigA) throw new Error("expected sigA");
      expect(sigA.key).toBe("sig_a");
      const sigB = defs[1];
      if (!sigB) throw new Error("expected sigB");
      expect(sigB.key).toBe("sig_b");
    });

    test("Features.notifications() injects notifications field, prompt section, and signal", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        result: z.object({ outcome: z.string() }),
        agentPrompt: "Do the thing.",
        features: [Features.notifications()],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          outcome: { type: "string" },
          $boboddy_notifications_v1: { type: "array" },
        },
      });
      expect(spec.prompt).toContain("## User Notifications");
      expect(spec.prompt).toMatch(/^Do the thing\.\n\n/);
      expect(spec.signalExtractorDefinitions).toContainEqual({
        key: "$boboddy_notifications_v1",
        sourcePath: "$boboddy_notifications_v1",
        type: "array",
        required: false,
        availableWhenResultStatusIn: null,
      });
    });

    test("Features.feedbackRequests() is backed by the same notifications signal", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        result: z.object({ outcome: z.string() }),
        agentPrompt: "Do the thing.",
        features: [Features.feedbackRequests()],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          $boboddy_notifications_v1: { type: "array" },
        },
      });
      expect(Features.feedbackRequests.signal.key).toBe(
        "$boboddy_notifications_v1",
      );
      expect(spec.signalExtractorDefinitions).toContainEqual({
        key: "$boboddy_notifications_v1",
        sourcePath: "$boboddy_notifications_v1",
        type: "array",
        required: false,
        availableWhenResultStatusIn: null,
      });
    });
  });

  // `packages/sdks/js/tsconfig.json` includes `test/**/*.ts`, so every
  // `@ts-expect-error` below IS the assertion: `bun run typecheck` fails if the
  // error it claims stops being reported. `bun test` only proves the runtime
  // still behaves, since the types are erased by then.
  describe("signal sourcePath is checked against the result schema", () => {
    const result = z.object({
      findings: z.string(),
      nested: z.object({ deep: z.number() }),
    });

    test("rejects a sourcePath that does not exist in the result schema", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        result,
        // @ts-expect-error "totally.not.real" is not a path in `result`.
        signals: [{ sourcePath: "totally.not.real" }],
      });

      // The type error is the point; the runtime is unchanged and still emits
      // the (dead) extractor, which is what `validateDefinitionSpecs` catches
      // for JS and hand-edited callers.
      expect(spec.signalExtractorDefinitions[0]?.sourcePath).toBe(
        "totally.not.real",
      );
    });

    test("accepts top-level and nested paths that do exist", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        result,
        signals: [
          { sourcePath: "findings" },
          { key: "deep", sourcePath: "nested.deep" },
        ],
      });

      expect(spec.signalExtractorDefinitions.map((s) => s.key)).toEqual([
        "findings",
        "deep",
      ]);
    });

    test("accepts signals on a step with no result schema", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        signals: [{ sourcePath: "whatever.the.agent.returns" }],
      });

      expect(spec.resultSchemaJson).toBeNull();
      expect(spec.signalExtractorDefinitions).toHaveLength(1);
    });
  });
});
