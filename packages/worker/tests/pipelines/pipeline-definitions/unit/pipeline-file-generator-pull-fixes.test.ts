import { describe, expect, test } from "bun:test";
import { gen, makePipeline, makeStep } from "./pipeline-file-generator-test-helpers";

// Regression tests for https://github.com/boboddy-dev/boboddy-platform/issues/125
// (`pipelines pull` was dropping `additionalPipelineInput` entirely and
// emitting `.advance()` rules that reference `all(...)`/`any(...)` without
// destructuring them from the callback params).
//
// The flat SDK rewrite (Phase 6) removed the mechanism issue #125 was about —
// there is no more pipeline-level `additionalPipelineInput` layer, and no
// `.advance()` callback to destructure. Every work-item field binding, custom
// or not, now reconstructs directly and independently as `ctx.workItem.field(...)`
// in whichever step's own mapper uses it (see `pipeline-file-generator.ts`'s
// module doc). These tests carry the original regression forward onto the new
// shape: a custom work-item field must never be dropped or emitted as a
// broken placeholder, in a single step or across several.

describe("custom work-item field bindings are never dropped", () => {
  test("reconstructs the same custom field independently on two different steps", () => {
    const stepA = makeStep({
      key: "bad-data-investigation",
      position: 0,
      inputBindingsJson: {
        workItemTitle: { source: "work_item", field: "title" },
        workItemDescription: { source: "work_item", field: "description" },
        companyNames: { source: "work_item", field: "fields.What are the Company Name(s):" },
        employeeEmails: { source: "work_item", field: "fields.What are the Employee Email(s):" },
      },
    });
    const stepB = makeStep({
      key: "failing-test-reproduction",
      position: 1,
      inputBindingsJson: {
        workItemTitle: { source: "work_item", field: "title" },
        workItemDescription: { source: "work_item", field: "description" },
        companyNames: { source: "work_item", field: "fields.What are the Company Name(s):" },
        employeeEmails: { source: "work_item", field: "fields.What are the Employee Email(s):" },
      },
    });

    const output = gen(makePipeline([stepA, stepB]));

    // Reconstructed on both steps, not just once at a pipeline level — there
    // is no pipeline level to reconstruct it at anymore.
    const companyNamesOccurrences = output.split('companyNames: ctx.workItem.field("What are the Company Name(s):")').length - 1;
    const employeeEmailsOccurrences = output.split('employeeEmails: ctx.workItem.field("What are the Employee Email(s):")').length - 1;
    expect(companyNamesOccurrences).toBe(2);
    expect(employeeEmailsOccurrences).toBe(2);

    // No broken placeholders of any kind.
    expect(output).not.toContain("undefined as never");
    expect(output).not.toContain("TODO");
    expect(output).not.toContain("additionalPipelineInput");

    // No pipeline-level input schema is needed for this — these are
    // work-item bindings, not pipeline_input bindings.
    expect(output).not.toContain("import { z }");
    expect(output).not.toContain("input: z.object(");
  });

  test("a single step with a custom field needs no fallback placeholder", () => {
    const step = makeStep({
      inputBindingsJson: {
        companyNames: { source: "work_item", field: "fields.Company Names" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain('companyNames: ctx.workItem.field("Company Names")');
    expect(output).not.toContain("TODO");
  });
});

describe("pipeline-level input schema (ctx.pipelineInput)", () => {
  const PIPELINE_INPUT_SCHEMA_JSON = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      diff: { type: "string" },
    },
    required: ["diff"],
    additionalProperties: false,
  };

  test("reconstructs definePipeline({ input }) and per-step ctx.pipelineInput bindings, not a per-step additionalPipelineInput placeholder", () => {
    const stepA = makeStep({
      key: "analyze",
      position: 0,
      inputBindingsJson: {
        diff: { source: "pipeline_input", path: "diff" },
      },
    });

    const output = gen(makePipeline([stepA], { inputSchemaJson: PIPELINE_INPUT_SCHEMA_JSON }));

    expect(output).toContain("input: z.object(");
    expect(output).toContain('diff: ctx.pipelineInput("diff")');
    expect(output).not.toContain("additionalPipelineInput");
    expect(output).toContain('import { z } from "zod";');
  });

  test("omits the input field entirely when the pipeline declares no input schema", () => {
    const output = gen(makePipeline([makeStep()]));
    expect(output).not.toContain("input: z.object(");
    expect(output).not.toContain('import { z } from "zod";');
  });
});
