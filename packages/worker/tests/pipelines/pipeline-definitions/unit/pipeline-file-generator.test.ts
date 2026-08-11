import { describe, expect, test } from "bun:test";
import { gen, makePipeline, makeStep } from "./pipeline-file-generator-test-helpers";

// ─── work_item binding ────────────────────────────────────────────────────────

describe("work_item binding", () => {
  test("emits input.workItemTitle for a work_item title binding", () => {
    const step = makeStep({
      inputBindingsJson: {
        subject: { source: "work_item", field: "title" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("input.workItemTitle");
    expect(output).not.toContain("workItem.title");
  });

  test("emits input.workItemDescription for a work_item description binding", () => {
    const step = makeStep({
      inputBindingsJson: {
        body: { source: "work_item", field: "description" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("input.workItemDescription");
    expect(output).not.toContain("workItem.description");
  });

  test("includes input in destructured ctx param when work_item binding is present", () => {
    const step = makeStep({
      inputBindingsJson: {
        title: { source: "work_item", field: "title" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toMatch(/\(\s*\{\s*[^}]*input[^}]*\}\s*\)/);
    // standalone "workItem" (not "workItemTitle"/"workItemDescription") must not appear as a ctx binding
    expect(output).not.toMatch(/\bworkItem\b(?!Title|Description)/);
  });

  test("skips auto-injected workItemTitle and workItemDescription bindings", () => {
    const step = makeStep({
      inputBindingsJson: {
        workItemTitle: { source: "work_item", field: "title" },
        workItemDescription: { source: "work_item", field: "description" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("_ctx");
    expect(output).not.toContain("input.workItemTitle");
    expect(output).not.toContain("input.workItemDescription");
  });

  test("emits TODO comment for custom work item field bindings", () => {
    const step = makeStep({
      inputBindingsJson: {
        company: { source: "work_item", field: "fields.Company" },
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("TODO");
    expect(output).toContain("Company");
  });
});

// ─── Import line ──────────────────────────────────────────────────────────────

describe("imports", () => {
  test("does not import Computed or Rule even when computed signal definitions are present", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "sum_a_b", operator: "greaterThan", value: 3 }] },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
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
    expect(output).not.toMatch(/import \{[^}]*Computed[^}]*\}/);
    expect(output).not.toMatch(/import \{[^}]*Rule[^}]*\}/);
    // computed is expressed via ctx destructuring, not imports
    expect(output).toContain("sum(stepSignals.");
  });

  test("does not import Computed or Rule when no computed signal definitions are present", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "score", operator: "greaterThan", value: 5 }] },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
      },
      computedSignalDefinitions: [],
    });

    const output = gen(makePipeline([step]));
    expect(output).not.toContain("Computed");
    expect(output).not.toContain("Rule");
  });
});

// ─── Single-condition rules ───────────────────────────────────────────────────

describe("single-condition rules", () => {
  test("emits stepSignals.key.op(val).then(outcome) for a plain signal fact", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "clarity_score", operator: "greaterThan", value: 7 }] },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
      },
      computedSignalDefinitions: [],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`stepSignals.clarity_score.gt(7).then("continue")`);
    expect(output).not.toContain("Rule");
  });

  test("emits ctx computed method for a computed signal fact", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "sum_score_a_score_b", operator: "greaterThan", value: 5 }] },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
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
    expect(output).toContain(`sum(stepSignals.score_a, stepSignals.score_b).gt(5).then("continue")`);
    expect(output).not.toContain("Computed");
  });
});

// ─── Multi-condition rules ────────────────────────────────────────────────────

describe("multi-condition rules", () => {
  test("emits all(...).then(outcome) for a multi-condition all rule mixing computed and plain facts", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: {
              all: [
                { fact: "average_quality_security", operator: "greaterThanInclusive", value: 7 },
                { fact: "flagged", operator: "equal", value: false },
              ],
            },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
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
    expect(output).toContain(`avg(stepSignals.quality, stepSignals.security).gte(7)`);
    expect(output).toContain(`stepSignals.flagged.eq(false)`);
    expect(output).toContain(`.then("continue")`);
    expect(output).not.toContain("Computed");
    expect(output).not.toContain("Rule");
  });

  test("handles computed signal in nested any condition group", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: {
              all: [
                { fact: "required_check", operator: "equal", value: true },
                { any: [{ fact: "sum_x_y", operator: "greaterThan", value: 10 }] },
              ],
            },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
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
    expect(output).toContain(`sum(stepSignals.x, stepSignals.y).gt(10)`);
    expect(output).not.toContain("Computed");
  });
});

// ─── All 8 computed ctx method mappings ──────────────────────────────────────

describe("computed ctx method mapping", () => {
  const cases: Array<[string, string]> = [
    ["average", "avg"],
    ["weighted_average", "weightedAvg"],
    ["sum", "sum"],
    ["min", "min"],
    ["max", "max"],
    ["count", "count"],
    ["boolean_any", "booleanAny"],
    ["boolean_all", "booleanAll"],
  ];

  for (const [wireType, expectedMethod] of cases) {
    test(`maps wire type "${wireType}" to ctx method "${expectedMethod}"`, () => {
      const key = `${wireType}_sig_a_sig_b`;
      const step = makeStep({
        advancementPolicyDefinition: {
          rulesJson: {
            rules: [{
              conditions: { all: [{ fact: key, operator: "equal", value: true }] },
              event: { type: "continue" },
            }],
          },
          defaultEventType: "continue",
          defaultEventParamsJson: null,
          allowedEventTypes: ["continue"],
        },
        computedSignalDefinitions: [{
          key,
          type: wireType,
          inputSignalKeys: ["sig_a", "sig_b"],
          configJson: null,
          availableWhenResultStatusIn: null,
        }],
      });

      const output = gen(makePipeline([step]));
      expect(output).toContain(`${expectedMethod}(stepSignals.sig_a, stepSignals.sig_b)`);
      expect(output).not.toContain("Computed");
    });
  }
});

// ─── Computed with options ────────────────────────────────────────────────────
// The fluent ctx API doesn't expose configJson/availableWhenResultStatusIn;
// the new generator uses the ctx method form regardless of those fields.

describe("computed signals", () => {
  test("uses ctx weightedAvg method even when configJson is set on the server", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "weighted_average_a_b", operator: "greaterThan", value: 0.5 }] },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
      },
      computedSignalDefinitions: [{
        key: "weighted_average_a_b",
        type: "weighted_average",
        inputSignalKeys: ["a", "b"],
        configJson: { weights: [0.3, 0.7] },
        availableWhenResultStatusIn: null,
      }],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`weightedAvg(stepSignals.a, stepSignals.b).gt(0.5).then("continue")`);
    expect(output).not.toContain("Computed");
  });

  test("uses ctx sum method even when availableWhenResultStatusIn is set on the server", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "sum_p_q", operator: "greaterThan", value: 1 }] },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
      },
      computedSignalDefinitions: [{
        key: "sum_p_q",
        type: "sum",
        inputSignalKeys: ["p", "q"],
        configJson: null,
        availableWhenResultStatusIn: ["success", "partial"],
      }],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`sum(stepSignals.p, stepSignals.q).gt(1).then("continue")`);
    expect(output).not.toContain("Computed");
  });

  test("omits options argument when both configJson and availableWhenResultStatusIn are null", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "min_a_b", operator: "greaterThan", value: 0 }] },
            event: { type: "continue" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
      },
      computedSignalDefinitions: [{
        key: "min_a_b",
        type: "min",
        inputSignalKeys: ["a", "b"],
        configJson: null,
        availableWhenResultStatusIn: null,
      }],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`min(stepSignals.a, stepSignals.b).gt(0).then("continue")`);
    expect(output).not.toContain("Computed");
  });
});
