import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  pipeline,
} from "../src/definitions/pipelines/builder";
import { defineStep } from "../src/definitions/steps/define-step";

const noInputStep = defineStep({
  key: "no-input",
  name: "No Input Step",
  agentPrompt: "Do the work.",
  result: z.object({}),
  signals: [],
});

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

const enrichedStep = defineStep({
  key: "enriched",
  name: "Enriched Step",
  agentPrompt: "Use the bound metadata fields to produce the result.",
  additionalInput: z.object({
    jiraProject: z.string().nullable().optional(),
    owner: z.string().optional(),
    priority: z.string().nullable().optional(),
  }),
  result: z.object({ ok: z.boolean() }),
  signals: [{ sourcePath: "ok" }],
});

describe("pipeline() builder — parity coverage (Phase 5) — step ordering and input bindings", () => {
  describe("step ordering and metadata", () => {
    test.concurrent("assigns positions 1-indexed in declaration order", () => {
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

      const step0 = spec.steps[0];
      if (!step0) throw new Error("expected step0");
      const step1 = spec.steps[1];
      if (!step1) throw new Error("expected step1");
      expect(step0.position).toBe(1);
      expect(step1.position).toBe(2);
    });

    test.concurrent(
      "carries step key, name, and description into the output",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.stepKey).toBe("reproduce");
        expect(step0.stepName).toBe("Reproduce Issue");
        expect(step0.stepDescription).toBeNull();
      },
    );
  });

  describe("input bindings", () => {
    test.concurrent(
      "workItemTitle and workItemDescription are auto-injected into every step",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(noInputStep)
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          workItemTitle: { source: "work_item", field: "title" },
          workItemDescription: { source: "work_item", field: "description" },
        });
      },
    );

    test.concurrent(
      "input.workItemTitle and input.workItemDescription bind to work_item source",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          title: { source: "work_item", field: "title" },
          description: { source: "work_item", field: "description" },
        });
      },
    );

    test.concurrent(
      "pipeline-level inputBindings via workItem.field are injected into every step",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalPipelineInput: {
            schema: z.object({
              company: z.string().nullable(),
              storyPoints: z.number().nullable(),
            }),
            bindings: ({ workItem }) => ({
              company: workItem.field("Company"),
              storyPoints: workItem.field("Story Points"),
            }),
          },
        })
          .step(noInputStep, () => ({}))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          workItemTitle: { source: "work_item", field: "title" },
          workItemDescription: { source: "work_item", field: "description" },
          company: { source: "work_item", field: "fields.Company" },
          storyPoints: { source: "work_item", field: "fields.Story Points" },
        });
      },
    );

    test.concurrent(
      "mapper bindings for additionalInput fields are included in step input",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(enrichedStep, ({ literal }) => ({ priority: literal("high") }))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          priority: { source: "literal", value: "high" },
        });
      },
    );

    test.concurrent(
      "pipeline-level additionalStepInput bindings are injected into every step",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalStepInput: {
            schema: z.object({ priority: z.string().nullable() }),
            bindings: ({ workItemField }) => ({
              priority: workItemField("Priority"),
            }),
          },
        })
          .step(enrichedStep, () => ({}))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          priority: { source: "work_item", field: "fields.Priority" },
        });
      },
    );

    test.concurrent(
      "pipeline additionalStepInput is overridden by explicit step bindings",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalStepInput: {
            schema: z.object({ owner: z.string() }),
            bindings: ({ literal }) => ({ owner: literal("pipeline-owner") }),
          },
        })
          .step(enrichedStep, ({ literal }) => ({
            owner: literal("explicit-owner"),
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          owner: { source: "literal", value: "explicit-owner" },
        });
      },
    );

    test.concurrent(
      "explicit step bindings override pipeline-level inputBindings",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalPipelineInput: {
            schema: z.object({ title: z.string().optional() }),
            bindings: ({ literal }) => ({ title: literal("from-pipeline") }),
          },
        })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          title: { source: "work_item", field: "title" },
        });
      },
    );

    test.concurrent(
      "literal bindings serialize correctly at pipeline and step level",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalPipelineInput: {
            schema: z.object({ model: z.string() }),
            bindings: ({ literal }) => ({
              model: literal("gpt-4o"),
            }),
          },
        })
          .step(reproduceStep, ({ input, literal }) => ({
            title: input.workItemTitle,
            description: literal("hardcoded description"),
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          model: { source: "literal", value: "gpt-4o" },
          description: { source: "literal", value: "hardcoded description" },
        });
      },
    );

    test.concurrent(
      "additionalPipelineInput.bindings throws on keys not in schema",
      () => {
        expect(() =>
          pipeline({
            key: "p",
            name: "P",
            additionalPipelineInput: {
              schema: z.object({ model: z.string() }),
              bindings: ({ literal }) => ({
                model: literal("gpt-4o"),
                asdf: literal(123),
              }),
            },
          }),
        ).toThrow(
          'additionalPipelineInput.bindings returned key not in schema: "asdf"',
        );
      },
    );

    test.concurrent(
      "additionalStepInput.bindings throws on keys not in schema",
      () => {
        expect(() =>
          pipeline({
            key: "p",
            name: "P",
            additionalStepInput: {
              schema: z.object({ owner: z.string() }),
              bindings: ({ literal }) => ({
                owner: literal("platform"),
                asdf: literal(123),
              }),
            },
          }),
        ).toThrow(
          'additionalStepInput.bindings returned key not in schema: "asdf"',
        );
      },
    );

    test.concurrent(
      "nested input.x.y proxies serialize to dotted-path bindings",
      () => {
        const nestedInputSchema = z.object({
          ticket: z.object({
            title: z.string(),
            description: z.string(),
          }),
        });
        const nestedStep = defineStep({
          key: "nested-step",
          name: "Nested Step",
          agentPrompt: "Do the work.",
          additionalInput: z.object({
            title: z.string(),
            description: z.string(),
          }),
          result: z.object({}),
          signals: [],
        });

        const spec = pipeline({
          key: "p",
          name: "P",
          additionalPipelineInput: {
            schema: nestedInputSchema,
            bindings: ({ workItem }) => ({ ticket: workItem.field("ticket") }),
          },
        })
          .step(nestedStep, ({ input }) => ({
            title: input.ticket.title,
            description: input.ticket.description,
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        const step0 = spec.steps[0];
        if (!step0) throw new Error("expected step0");
        expect(step0.inputBindingsJson).toMatchObject({
          title: { source: "pipeline_input", path: "ticket.title" },
          description: { source: "pipeline_input", path: "ticket.description" },
        });
      },
    );
  });
});
