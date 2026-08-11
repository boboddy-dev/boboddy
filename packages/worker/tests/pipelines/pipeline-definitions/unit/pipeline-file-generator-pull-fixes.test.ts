import { describe, expect, test } from "bun:test";
import { gen, makePipeline, makeStep } from "./pipeline-file-generator-test-helpers";

// Regression tests for https://github.com/boboddy-dev/boboddy-platform/issues/125
// `pipelines pull` was dropping `additionalPipelineInput` entirely and emitting
// `.advance()` rules that reference `all(...)`/`any(...)` without destructuring
// them from the callback params.

// ─── additionalPipelineInput reconstruction ──────────────────────────────────

describe("additionalPipelineInput", () => {
  const PIPELINE_INPUT_SCHEMA_JSON = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      companyNames: { type: "string" },
      employeeEmails: { type: "string" },
    },
    required: ["companyNames", "employeeEmails"],
    additionalProperties: false,
  };

  test("reconstructs a pipeline-level additionalPipelineInput block instead of dropping it", () => {
    const stepA = makeStep({
      key: "bad-data-investigation",
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

    const output = gen(
      makePipeline([stepA, stepB], { inputSchemaJson: PIPELINE_INPUT_SCHEMA_JSON }),
    );

    // Emitted once, at the pipeline level.
    expect(output).toContain("additionalPipelineInput: {");
    expect(output).toContain('workItem.field("What are the Company Name(s):")');
    expect(output).toContain('workItem.field("What are the Employee Email(s):")');

    // Must not leak into per-step mappers as broken TODO placeholders.
    expect(output).not.toContain("undefined as never");
    expect(output).not.toContain("TODO: configure via additionalPipelineInput");

    // Zod schema + zod import needed to declare it.
    expect(output).toContain("z.object(");
    expect(output).toContain('import { z } from "zod";');
  });

  test("falls back to per-step TODO placeholders when there's no pipeline input schema", () => {
    const step = makeStep({
      inputBindingsJson: {
        companyNames: { source: "work_item", field: "fields.Company Names" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).not.toContain("additionalPipelineInput: {");
    expect(output).toContain("TODO: configure via additionalPipelineInput");
  });
});

// ─── .advance() combinator destructuring ─────────────────────────────────────

describe(".advance() combinator destructuring", () => {
  test("destructures `all` from the .advance() callback when a multi-condition all(...) rule is emitted", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: {
              all: [
                { fact: "confidence", operator: "greaterThanInclusive", value: 0.8 },
                { fact: "reproduced", operator: "equal", value: true },
              ],
            },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "block",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
      computedSignalDefinitions: [],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`all(stepSignals.confidence.gte(0.8), stepSignals.reproduced.eq(true)).then("continue")`);
    // The callback signature must destructure every identifier used in its body.
    expect(output).toMatch(/\(\s*\{\s*all\s*,\s*stepSignals\s*\}\s*\)\s*=>/);
  });

  test("destructures `any` from the .advance() callback when a single-condition any(...) rule is emitted", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: {
              any: [{ fact: "flagged", operator: "equal", value: true }],
            },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "block",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
      computedSignalDefinitions: [],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`any(stepSignals.flagged.eq(true)).then("continue")`);
    expect(output).toMatch(/\(\s*\{\s*any\s*,\s*stepSignals\s*\}\s*\)\s*=>/);
  });
});
