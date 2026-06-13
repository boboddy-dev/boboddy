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
        `Open ${env.BASE_URL} for ${input.title} and save artifacts to ${boboddy.artifactsDir}`,
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
      expect(defs[0]!.key).toBe("score");
      expect(defs[1]!.key).toBe("sig_a");
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
      expect(defs[0]!.key).toBe("sig_a");
      expect(defs[1]!.key).toBe("sig_b");
    });

    test("Features.feedbackRequests() injects feedbackRequests field, prompt section, and signal", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        result: z.object({ outcome: z.string() }),
        agentPrompt: "Do the thing.",
        features: [Features.feedbackRequests()],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          outcome: { type: "string" },
          $boboddy_feedbackRequests_v1: { type: "array" },
        },
      });
      expect(spec.prompt).toContain("## Feedback Requests");
      expect(spec.prompt).toMatch(/^Do the thing\.\n\n/);
      expect(spec.signalExtractorDefinitions).toContainEqual({
        key: "$boboddy_feedback_request_v1",
        sourcePath: "$boboddy_feedbackRequests_v1",
        type: "array",
        required: false,
        availableWhenResultStatusIn: null,
      });
    });
  });

  describe("plugins", () => {
    test("opencodePluginJson defaults to null when not provided", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
      });
      expect(spec.opencodePluginJson).toBeNull();
    });

    test("maps plugins array to opencodePluginJson", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        plugins: ["opencode-wakatime", ["@my-org/plugin", { key: "val" }]],
      });
      expect(spec.opencodePluginJson).toEqual([
        "opencode-wakatime",
        ["@my-org/plugin", { key: "val" }],
      ]);
    });

    test("maps multiple string plugins to opencodePluginJson", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        plugins: ["opencode-wakatime", "opencode-helicone-session"],
      });

      expect(spec.opencodePluginJson).toEqual([
        "opencode-wakatime",
        "opencode-helicone-session",
      ]);
    });

    test("explicit null plugins stores null", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        plugins: null,
      });
      expect(spec.opencodePluginJson).toBeNull();
    });
  });

  describe("signals", () => {
    test("key defaults to sourcePath, type is derived from result schema", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        result: z.object({
          score: z.number(),
          label: z.string(),
          active: z.boolean(),
          tags: z.array(z.string()),
          meta: z.object({ value: z.number() }),
        }),
        signals: [
          { sourcePath: "score" },
          { sourcePath: "label" },
          { sourcePath: "active" },
          { sourcePath: "tags" },
          { sourcePath: "meta" },
          { sourcePath: "meta.value" },
        ],
      });

      const defs = spec.signalExtractorDefinitions;
      expect(defs[0]).toEqual({
        key: "score",
        sourcePath: "score",
        type: "number",
        required: true,
        availableWhenResultStatusIn: null,
      });
      expect(defs[1]).toEqual({
        key: "label",
        sourcePath: "label",
        type: "string",
        required: true,
        availableWhenResultStatusIn: null,
      });
      expect(defs[2]).toEqual({
        key: "active",
        sourcePath: "active",
        type: "boolean",
        required: true,
        availableWhenResultStatusIn: null,
      });
      expect(defs[3]).toEqual({
        key: "tags",
        sourcePath: "tags",
        type: "array",
        required: true,
        availableWhenResultStatusIn: null,
      });
      expect(defs[4]).toEqual({
        key: "meta",
        sourcePath: "meta",
        type: "object",
        required: true,
        availableWhenResultStatusIn: null,
      });
      expect(defs[5]).toEqual({
        key: "meta.value",
        sourcePath: "meta.value",
        type: "number",
        required: true,
        availableWhenResultStatusIn: null,
      });
    });

    test("explicit key and required override auto-derivation", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        result: z.object({ score: z.number() }),
        signals: [{ key: "custom_key", sourcePath: "score", required: false }],
      });

      expect(spec.signalExtractorDefinitions[0]).toEqual({
        key: "custom_key",
        sourcePath: "score",
        type: "number",
        required: false,
        availableWhenResultStatusIn: null,
      });
    });
  });
});
