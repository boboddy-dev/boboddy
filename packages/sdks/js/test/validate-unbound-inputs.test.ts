import { describe, expect, test } from "bun:test";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import {
  parallelStep,
  pipelineSpec,
  pipelineStep,
  stepSpecWithOverrides,
} from "./definition-spec-fixtures";

/**
 * `checkUnboundRequiredInputs` (`unbound-required-input`, error-tier) and
 * `checkBindingTargetFields` (`binding-target-field`, a mix of info-tier —
 * an unbound field name the consumer step doesn't declare — and error-tier —
 * a `work_item` binding naming an unknown field). Split into their own
 * file, alongside `validate-signal-binding-types.test.ts` for the
 * warning-tier `binding-type-mismatch` check, per this package's convention
 * of keeping `validate-definition-specs.test.ts` itself under the repo's
 * `max-lines` limit (see `validate-definition-specs-health-checks.test.ts`).
 */
describe("validateDefinitionSpecs — unbound required inputs", () => {
  const REQUIRES_FIELD1 = {
    type: "object",
    properties: {
      field1: { type: "string" },
      field2: { type: "string" },
    },
    required: ["field1"],
  };

  const consumer = (overrides: Record<string, unknown> = {}) =>
    stepSpecWithOverrides("consume", {
      inputSchemaJson: { ...REQUIRES_FIELD1, ...overrides },
    });

  test("rejects a required additionalInput field with no binding at all", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [pipelineSpec("p", [pipelineStep("consume", 1)])],
      steps: [consumer()],
    });
    const unbound = issues.filter((i) => i.check === "unbound-required-input");
    expect(unbound).toHaveLength(1);
    expect(unbound[0]?.severity).toBe("error");
    expect(unbound[0]?.message).toContain('requires input "field1"');
    expect(unbound[0]?.message).toContain('runs step "consume"');
  });

  test("accepts a required field that is bound", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: {
              field1: { source: "literal", value: "x" },
            },
          }),
        ]),
      ],
      steps: [consumer()],
    });
    expect(issues.filter((i) => i.check === "unbound-required-input")).toEqual(
      [],
    );
  });

  test("does not flag an optional (non-required) field left unbound", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: {
              field1: { source: "literal", value: "x" },
              // field2 is declared but not required, and not bound here.
            },
          }),
        ]),
      ],
      steps: [consumer()],
    });
    expect(issues.filter((i) => i.check === "unbound-required-input")).toEqual(
      [],
    );
  });

  test("treats workItemTitle/workItemDescription as always auto-bound", () => {
    // Neither key is a property of this step's own additionalInput schema,
    // but both are always-bound (see `bindings.ts`'s `serializeInputBindings`)
    // and must never be flagged as unbound *or* as an unknown target field.
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: {
              field1: { source: "literal", value: "x" },
              workItemTitle: { source: "work_item", field: "title" },
              workItemDescription: { source: "work_item", field: "description" },
            },
          }),
        ]),
      ],
      steps: [consumer()],
    });
    expect(
      issues.filter(
        (i) =>
          i.check === "unbound-required-input" ||
          i.check === "binding-target-field",
      ),
    ).toEqual([]);
  });

  test("stays quiet when the consumer step is not in the batch at all", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [pipelineSpec("p", [pipelineStep("consume", 1)])],
      steps: [],
    });
    expect(issues.filter((i) => i.check === "unbound-required-input")).toEqual(
      [],
    );
  });

  test("flags a missing required field independently per parallel branch", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          parallelStep("fanned", 1, {
            branchA: {
              stepKey: "consume",
              stepName: "consume",
              stepDescription: null,
              inputBindingsJson: {},
            },
            branchB: {
              stepKey: "consume",
              stepName: "consume",
              stepDescription: null,
              inputBindingsJson: { field1: { source: "literal", value: "x" } },
            },
          }),
        ]),
      ],
      steps: [consumer()],
    });
    const unbound = issues.filter((i) => i.check === "unbound-required-input");
    expect(unbound).toHaveLength(1);
    expect(unbound[0]?.message).toContain('branch "branchA"');
  });
});

describe("validateDefinitionSpecs — broken binding target fields", () => {
  const consumer = stepSpecWithOverrides("consume", {
    inputSchemaJson: {
      type: "object",
      properties: { known: { type: "string" } },
      required: [],
    },
  });

  test("flags (at info level, not error) a bound field name the consumer step never declares", () => {
    // Allowed, not rejected — a step may legitimately be handed context it
    // doesn't declare as an `additionalInput` field (the value is just
    // dropped) — so this is surfaced at info level only, in case it's an
    // unintentional typo rather than deliberate extra context.
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: {
              typoField: { source: "literal", value: "x" },
            },
          }),
        ]),
      ],
      steps: [consumer],
    });
    const targetIssues = issues.filter((i) => i.check === "binding-target-field");
    expect(targetIssues).toHaveLength(1);
    expect(targetIssues[0]?.severity).toBe("info");
    expect(targetIssues[0]?.message).toContain(
      'is passing information ("typoField") to step "consume" that it isn\'t explicitly asking for',
    );
    expect(targetIssues[0]?.message).toContain("Declared fields: known.");
  });

  test("accepts a bound field name the consumer step does declare", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: { known: { source: "literal", value: "x" } },
          }),
        ]),
      ],
      steps: [consumer],
    });
    expect(issues.filter((i) => i.check === "binding-target-field")).toEqual([]);
  });

  test("rejects a work_item binding whose field is neither a known top-level field nor fields.-prefixed", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: {
              known: { source: "work_item", field: "totallyMadeUp" },
            },
          }),
        ]),
      ],
      steps: [consumer],
    });
    const targetIssues = issues.filter((i) => i.check === "binding-target-field");
    expect(targetIssues).toHaveLength(1);
    expect(targetIssues[0]?.message).toContain(
      'work_item field "totallyMadeUp"',
    );
  });

  test("accepts a work_item binding naming a known top-level field", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: {
              known: { source: "work_item", field: "platformId" },
            },
          }),
        ]),
      ],
      steps: [consumer],
    });
    expect(issues.filter((i) => i.check === "binding-target-field")).toEqual([]);
  });

  test("accepts a work_item binding into the platform-specific fields. bag, unconditionally", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        pipelineSpec("p", [
          pipelineStep("consume", 1, {
            inputBindingsJson: {
              known: { source: "work_item", field: "fields.anyCustomLabelAtAll" },
            },
          }),
        ]),
      ],
      steps: [consumer],
    });
    expect(issues.filter((i) => i.check === "binding-target-field")).toEqual([]);
  });
});
