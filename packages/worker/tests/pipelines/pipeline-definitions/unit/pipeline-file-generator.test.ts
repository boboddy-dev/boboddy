import { describe, expect, test } from "bun:test";
import { gen, makePipeline, makeStep } from "./pipeline-file-generator-test-helpers";

// ─── Basic shape ──────────────────────────────────────────────────────────────

describe("basic shape", () => {
  test("emits definePipeline({states}) with a synthesized succeed terminal", () => {
    const output = gen(makePipeline([makeStep({ key: "review-code" })]));

    expect(output).toContain('import { definePipeline } from "@boboddy/sdk/definitions/pipelines";');
    expect(output).toContain("export default definePipeline({");
    expect(output).toContain('startAt: "review-code"');
    expect(output).toContain('"review-code": {');
    expect(output).toContain('kind: "step"');
    expect(output).toContain('next: "done"');
    expect(output).toContain('done: { kind: "succeed" }');
    expect(output).not.toContain(".build()");
    expect(output).not.toContain("pipeline(");
  });

  test("chains sequential steps by position and only terminates the last one", () => {
    const stepA = makeStep({ key: "step-a", position: 0 });
    const stepB = makeStep({ key: "step-b", position: 1 });

    const output = gen(makePipeline([stepB, stepA])); // deliberately out of order
    expect(output).toContain('startAt: "step-a"');
    expect(output.indexOf('"step-a"')).toBeLessThan(output.indexOf('"step-b"'));
    expect(output).toContain('"step-a": {');
    expect(output).toMatch(/"step-a":\s*\{[\s\S]*?next: "step-b"/);
    expect(output).toMatch(/"step-b":\s*\{[\s\S]*?next: "done"/);
  });

  test("picks a non-colliding terminal key when a state is already named `done`", () => {
    const output = gen(makePipeline([makeStep({ key: "done" })]));
    expect(output).toContain('next: "_done"');
    expect(output).toContain('_done: { kind: "succeed" }');
  });
});

// ─── work_item binding ────────────────────────────────────────────────────────

describe("work_item binding", () => {
  test("emits ctx.workItem.title for a work_item title binding", () => {
    const step = makeStep({
      inputBindingsJson: {
        subject: { source: "work_item", field: "title" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("ctx.workItem.title");
  });

  test("emits ctx.workItem.description for a work_item description binding", () => {
    const step = makeStep({
      inputBindingsJson: {
        body: { source: "work_item", field: "description" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("ctx.workItem.description");
  });

  test("skips auto-injected workItemTitle and workItemDescription bindings", () => {
    const step = makeStep({
      inputBindingsJson: {
        workItemTitle: { source: "work_item", field: "title" },
        workItemDescription: { source: "work_item", field: "description" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("() => ({})");
    expect(output).not.toContain("workItemTitle:");
    expect(output).not.toContain("workItemDescription:");
  });

  test("reconstructs a custom work-item field directly — no TODO placeholder needed", () => {
    const step = makeStep({
      inputBindingsJson: {
        company: { source: "work_item", field: "fields.Company" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain('company: ctx.workItem.field("Company")');
    expect(output).not.toContain("TODO");
    // "company" is a valid identifier, so the binding key is emitted bare.
    expect(output).not.toContain('"company":');
  });
});

// ─── Other binding sources ────────────────────────────────────────────────────

describe("other binding sources", () => {
  test("reconstructs a step_signal binding as ctx.signal(nodeKey, signalKey)", () => {
    const step = makeStep({
      inputBindingsJson: {
        rootCause: { source: "step_signal", stepKey: "investigate", signalKey: "rootCause" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain('rootCause: ctx.signal("investigate", "rootCause")');
  });

  test("reconstructs a step_output binding as ctx.output(nodeKey)", () => {
    const step = makeStep({
      inputBindingsJson: {
        fullResult: { source: "step_output", stepKey: "investigate" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain('fullResult: ctx.output("investigate")');
  });

  test("reconstructs a literal binding as ctx.literal(value) — fully supported, unlike the old builder", () => {
    const step = makeStep({
      inputBindingsJson: {
        appUrl: { source: "literal", value: "https://staging.example.com" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain('appUrl: ctx.literal("https://staging.example.com")');
    expect(output).not.toContain("not supported in SDK");
  });

  test("reconstructs a pipeline_input binding as ctx.pipelineInput(path)", () => {
    const step = makeStep({
      inputBindingsJson: {
        diff: { source: "pipeline_input", path: "diff" },
      },
    });

    const output = gen(makePipeline([step], { inputSchemaJson: { type: "object", properties: { diff: { type: "string" } } } }));
    expect(output).toContain('diff: ctx.pipelineInput("diff")');
    expect(output).toContain("input: z.object(");
  });
});

// ─── Imports ──────────────────────────────────────────────────────────────────

describe("imports", () => {
  test("imports neither Rule nor Computed when there is no blockWhen", () => {
    const output = gen(makePipeline([makeStep()]));
    expect(output).not.toMatch(/import \{[^}]*Rule[^}]*\} from "@boboddy\/sdk\/definitions\/pipelines"/);
    expect(output).not.toMatch(/import \{[^}]*Computed[^}]*\} from "@boboddy\/sdk\/definitions\/pipelines"/);
  });

  test("imports Rule (but not Computed) when a plain-signal blockWhen is emitted", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "confidence", operator: "lessThan", value: 7 }] },
            event: { type: "block" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain('import { definePipeline, Rule } from "@boboddy/sdk/definitions/pipelines";');
  });

  test("imports both Rule and Computed when a computed-signal blockWhen is emitted", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "sum_a_b", operator: "lessThan", value: 3 }] },
            event: { type: "block" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
      computedSignalDefinitions: [{
        key: "sum_a_b",
        type: "sum",
        inputSignalKeys: ["a", "b"],
        configJson: null,
        availableWhenResultStatusIn: null,
      }],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(
      'import { definePipeline, Rule, Computed } from "@boboddy/sdk/definitions/pipelines";',
    );
  });
});

// ─── blockWhen reconstruction ─────────────────────────────────────────────────

describe("blockWhen — single condition", () => {
  test("collapses a single-leaf `all` rule to Rule.when(...)", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "clarity_score", operator: "lessThan", value: 7 }] },
            event: { type: "block" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`blockWhen: Rule.when("clarity_score", "lessThan", 7)`);
    expect(output).not.toContain("Rule.all");
  });

  test("reconstructs a computed-signal condition as Rule.when(Computed.X([...]), ...)", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "sum_score_a_score_b", operator: "lessThan", value: 5 }] },
            event: { type: "block" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
      computedSignalDefinitions: [{
        key: "sum_score_a_score_b",
        type: "sum",
        inputSignalKeys: ["score_a", "score_b"],
        configJson: null,
        availableWhenResultStatusIn: null,
      }],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(
      `blockWhen: Rule.when(Computed.sum(["score_a", "score_b"]), "lessThan", 5)`,
    );
  });
});

describe("blockWhen — multiple conditions", () => {
  test("reconstructs a multi-condition `all` group mixing computed and plain facts", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: {
              all: [
                { fact: "average_quality_security", operator: "lessThan", value: 7 },
                { fact: "flagged", operator: "equal", value: true },
              ],
            },
            event: { type: "block" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
      computedSignalDefinitions: [{
        key: "average_quality_security",
        type: "average",
        inputSignalKeys: ["quality", "security"],
        configJson: null,
        availableWhenResultStatusIn: null,
      }],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(
      `blockWhen: Rule.all([Rule.signal(Computed.average(["quality", "security"]), "lessThan", 7), Rule.signal("flagged", "equal", true)])`,
    );
  });

  test("reconstructs a computed signal nested inside an `any` group", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: {
              all: [
                { fact: "required_check", operator: "equal", value: false },
                { any: [{ fact: "sum_x_y", operator: "greaterThan", value: 10 }] },
              ],
            },
            event: { type: "block" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
      computedSignalDefinitions: [{
        key: "sum_x_y",
        type: "sum",
        inputSignalKeys: ["x", "y"],
        configJson: null,
        availableWhenResultStatusIn: null,
      }],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`Rule.any([Rule.signal(Computed.sum(["x", "y"]), "greaterThan", 10)])`);
  });
});
