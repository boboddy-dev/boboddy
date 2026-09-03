import { describe, expect, test } from "bun:test";
import type { PipelineDefinitionSpec } from "../src/definitions/pipelines";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import {
  parallelStep,
  pipelineSpec,
  pipelineStep,
  stepSpecWithOverrides,
  type Bindings,
} from "./definition-spec-fixtures";

/**
 * `checkBindingTypeCompatibility` (`binding-type-mismatch`) — Phase 2's one
 * warning-tier check. Split out per this file's sibling
 * `validate-unbound-inputs.test.ts`'s own header comment.
 */
describe("validateDefinitionSpecs — binding type compatibility", () => {
  /** A consumer step whose single additionalInput field has the given declared type. */
  const consumerWithFieldType = (type: string) =>
    stepSpecWithOverrides("consume", {
      inputSchemaJson: {
        type: "object",
        properties: { field: { type } },
        required: [],
      },
    });

  /** A consumer field with no `type` keyword at all — an unresolvable target. */
  const consumerWithUnknownFieldType = () =>
    stepSpecWithOverrides("consume", {
      inputSchemaJson: {
        type: "object",
        properties: { field: {} },
        required: [],
      },
    });

  /** A pipeline with a producer step per `producerKeys` (in order) followed by
   * a "consume" node binding its single `field` input to `binding`. */
  const pipelineWithBinding = (
    producerKeys: readonly string[],
    binding: Bindings[string],
    pipelineInputSchemaJson?: Record<string, unknown> | null,
  ): PipelineDefinitionSpec => ({
    ...pipelineSpec("p", [
      ...producerKeys.map((key, index) => pipelineStep(key, index + 1)),
      pipelineStep("consume", producerKeys.length + 1, {
        inputBindingsJson: { field: binding },
      }),
    ]),
    ...(pipelineInputSchemaJson !== undefined
      ? { inputSchemaJson: pipelineInputSchemaJson }
      : {}),
  });

  test("step_signal: matching types produce no issue", () => {
    const producer = stepSpecWithOverrides("produce", {
      signalExtractorDefinitions: [
        {
          key: "sig",
          sourcePath: "sig",
          type: "number",
          required: true,
          availableWhenResultStatusIn: null,
        },
      ],
    });
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding(
          ["produce"],
          { source: "step_signal", stepKey: "produce", signalKey: "sig" },
        ),
      ],
      steps: [producer, consumerWithFieldType("number")],
    });
    expect(issues.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );
  });

  test("step_signal: mismatched types produce a warning", () => {
    const producer = stepSpecWithOverrides("produce", {
      signalExtractorDefinitions: [
        {
          key: "sig",
          sourcePath: "sig",
          type: "number",
          required: true,
          availableWhenResultStatusIn: null,
        },
      ],
    });
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding(
          ["produce"],
          { source: "step_signal", stepKey: "produce", signalKey: "sig" },
        ),
      ],
      steps: [producer, consumerWithFieldType("string")],
    });
    const mismatches = issues.filter((i) => i.check === "binding-type-mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.severity).toBe("warning");
    expect(mismatches[0]?.message).toContain('declared type "string"');
    expect(mismatches[0]?.message).toContain('signal "sig" of node "produce"');
    expect(mismatches[0]?.message).toContain('type "number"');
  });

  test("step_output: resolves the producer's result schema's top-level type", () => {
    const producer = stepSpecWithOverrides("produce", {
      resultSchemaJson: { type: "object", properties: {} },
    });
    const matching = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding(
          ["produce"],
          { source: "step_output", stepKey: "produce" },
        ),
      ],
      steps: [producer, consumerWithFieldType("object")],
    });
    expect(matching.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );

    const mismatched = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding(
          ["produce"],
          { source: "step_output", stepKey: "produce" },
        ),
      ],
      steps: [producer, consumerWithFieldType("string")],
    });
    expect(
      mismatched.filter((i) => i.check === "binding-type-mismatch"),
    ).toHaveLength(1);
  });

  test("signals_list: always resolves to array", () => {
    const fanOut = pipelineStep("review", 1, {
      kind: "fanOut",
      overSignalKey: "reviewer_count",
    });
    const matching = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          fanOut,
          pipelineStep("consume", 2, {
            inputBindingsJson: {
              field: { source: "signals_list", stepKey: "review" },
            },
          }),
        ]),
      ],
      steps: [consumerWithFieldType("array")],
    });
    expect(matching.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );

    const mismatched = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          fanOut,
          pipelineStep("consume", 2, {
            inputBindingsJson: {
              field: { source: "signals_list", stepKey: "review" },
            },
          }),
        ]),
      ],
      steps: [consumerWithFieldType("string")],
    });
    expect(
      mismatched.filter((i) => i.check === "binding-type-mismatch"),
    ).toHaveLength(1);
  });

  test("fan_out_item: never type-checked, even against a provably mismatched target", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            kind: "fanOut",
            overSignalKey: "count",
            inputBindingsJson: { field: { source: "fan_out_item" } },
          }),
        ]),
      ],
      steps: [consumerWithFieldType("string")],
    });
    expect(issues.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );
  });

  test("pipeline_input: resolves against the pipeline's own inputSchemaJson", () => {
    const pipelineInput = {
      type: "object",
      properties: { count: { type: "number" } },
    };

    const matching = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding(
          [],
          { source: "pipeline_input", path: "count" },
          pipelineInput,
        ),
      ],
      steps: [consumerWithFieldType("number")],
    });
    expect(matching.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );

    const mismatched = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding(
          [],
          { source: "pipeline_input", path: "count" },
          pipelineInput,
        ),
      ],
      steps: [consumerWithFieldType("string")],
    });
    expect(
      mismatched.filter((i) => i.check === "binding-type-mismatch"),
    ).toHaveLength(1);
  });

  test("work_item: a known top-level field is treated as string-typed", () => {
    const matching = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding([], { source: "work_item", field: "platformId" }),
      ],
      steps: [consumerWithFieldType("string")],
    });
    expect(matching.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );

    const mismatched = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding([], { source: "work_item", field: "platformId" }),
      ],
      steps: [consumerWithFieldType("number")],
    });
    expect(
      mismatched.filter((i) => i.check === "binding-type-mismatch"),
    ).toHaveLength(1);
  });

  test("work_item: a fields.-prefixed platform field is always unknown, never a mismatch", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding(
          [],
          { source: "work_item", field: "fields.customLabel" },
        ),
      ],
      // Declared type deliberately disagrees with "string" (what a known
      // top-level field would resolve to) to prove this is skipped, not
      // coincidentally matching.
      steps: [consumerWithFieldType("number")],
    });
    expect(issues.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );
  });

  test("both sides unknown: never a false positive", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding([], { source: "literal", value: 1 }),
      ],
      // `literal` never resolves a source type, and this consumer field has
      // no `type` keyword at all, so the target is unresolvable too.
      steps: [consumerWithUnknownFieldType()],
    });
    expect(issues.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );
  });

  test("a resolvable source against an unresolvable target produces no issue", () => {
    const producer = stepSpecWithOverrides("produce", {
      signalExtractorDefinitions: [
        {
          key: "sig",
          sourcePath: "sig",
          type: "number",
          required: true,
          availableWhenResultStatusIn: null,
        },
      ],
    });
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineWithBinding(
          ["produce"],
          { source: "step_signal", stepKey: "produce", signalKey: "sig" },
        ),
      ],
      steps: [producer, consumerWithUnknownFieldType()],
    });
    expect(issues.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );
  });

  test("workItemTitle/workItemDescription are never type-checked", () => {
    // These auto-bound field names aren't part of the consumer's own
    // additionalInput schema, so there is no target type to resolve them
    // against — deliberately skipped rather than guessed at.
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: {
              workItemTitle: { source: "work_item", field: "platformId" },
            },
          }),
        ]),
      ],
      steps: [consumerWithFieldType("string")],
    });
    expect(issues.filter((i) => i.check === "binding-type-mismatch")).toEqual(
      [],
    );
  });

  test("checks a parallel branch's own binding against its own step's declared type", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          parallelStep("fanned", 1, {
            branchA: {
              stepKey: "consume",
              stepName: "consume",
              stepDescription: null,
              inputBindingsJson: {
                field: { source: "work_item", field: "platformId" },
              },
            },
          }),
        ]),
      ],
      steps: [consumerWithFieldType("number")],
    });
    const mismatches = issues.filter((i) => i.check === "binding-type-mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.message).toContain('branch "branchA"');
  });
});
