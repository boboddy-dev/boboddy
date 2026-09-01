import { describe, expect, test } from "bun:test";
import { gen, makePipeline, makeStep } from "./pipeline-file-generator-test-helpers";

// Split out of pipeline-file-generator.test.ts to stay under this repo's
// max-lines limit: computed-signal mapping, cross-pipeline routing, and the
// "advancement shapes the flat SDK cannot express" PULL WARNING fallback.

describe("computed ctx method mapping", () => {
  const cases: Array<[string, string]> = [
    ["average", "average"],
    ["weighted_average", "weightedAverage"],
    ["sum", "sum"],
    ["min", "min"],
    ["max", "max"],
    ["count", "count"],
    ["boolean_any", "booleanAny"],
    ["boolean_all", "booleanAll"],
  ];

  for (const [wireType, expectedFactory] of cases) {
    test(`maps wire type "${wireType}" to Computed.${expectedFactory}`, () => {
      const key = `${wireType}_sig_a_sig_b`;
      const step = makeStep({
        advancementPolicyDefinition: {
          rulesJson: {
            rules: [{
              conditions: { all: [{ fact: key, operator: "equal", value: true }] },
              event: { type: "block" },
            }],
          },
          defaultEventType: "continue",
          defaultEventParamsJson: null,
          allowedEventTypes: ["continue", "block"],
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
      expect(output).toContain(`Computed.${expectedFactory}(["sig_a", "sig_b"])`);
    });
  }

  // The `Computed.X([...])` factories don't expose configJson/
  // availableWhenResultStatusIn as a second argument here — this generator
  // intentionally drops them, matching the SDK's own minimal usage in every
  // archetype/starter template. A future ticket can add the options argument
  // if a real pulled pipeline needs it round-tripped.
  test("omits an options argument even when configJson/availableWhenResultStatusIn are set on the server", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "weighted_average_a_b", operator: "lessThan", value: 0.5 }] },
            event: { type: "block" },
          }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "block"],
      },
      computedSignalDefinitions: [{
        key: "weighted_average_a_b",
        type: "weighted_average",
        inputSignalKeys: ["a", "b"],
        configJson: { weights: [0.3, 0.7] },
        availableWhenResultStatusIn: ["success"],
      }],
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`Computed.weightedAverage(["a", "b"])`);
    expect(output).not.toContain("weights");
  });
});

// ─── Routing ──────────────────────────────────────────────────────────────────

describe("routing to another pipeline", () => {
  test("reconstructs next: { routeToPipeline } for a route default outcome", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: { rules: [] },
        defaultEventType: "route",
        defaultEventParamsJson: { pipelineKey: "failing-test-repro" },
        allowedEventTypes: ["route"],
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`next: { routeToPipeline: "failing-test-repro" }`);
    // A route exit is terminal; no synthesized succeed state is needed.
    expect(output).not.toContain('"done"');
  });

  test("combines a route default with a blockWhen rule", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{
            conditions: { all: [{ fact: "confidence", operator: "lessThan", value: 0.8 }] },
            event: { type: "block" },
          }],
        },
        defaultEventType: "route",
        defaultEventParamsJson: { pipelineKey: "failing-test-repro" },
        allowedEventTypes: ["route", "block"],
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`blockWhen: Rule.when("confidence", "lessThan", 0.8)`);
    expect(output).toContain(`next: { routeToPipeline: "failing-test-repro" }`);
  });

  test("forwards a route's inputJson", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: { rules: [] },
        defaultEventType: "route",
        defaultEventParamsJson: { pipelineKey: "other", inputJson: { foo: "bar" } },
        allowedEventTypes: ["route"],
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain(`next: { routeToPipeline: "other", input: {"foo":"bar"} }`);
  });
});

// ─── Unsupported advancement shapes ───────────────────────────────────────────

describe("advancement shapes the flat SDK cannot express", () => {
  test("flags more than one rule with a PULL WARNING and a safe fallback next", () => {
    const step = makeStep({
      key: "step-a",
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [
            { conditions: { all: [{ fact: "a", operator: "equal", value: true }] }, event: { type: "block" } },
            { conditions: { all: [{ fact: "b", operator: "equal", value: true }] }, event: { type: "continue" } },
          ],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["block", "continue"],
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("PULL WARNING");
    expect(output).toContain("at most one");
    expect(output).toContain('next: "done"');
    expect(output).not.toContain("blockWhen:");
  });

  test("flags a rule resolving to a non-block outcome", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: {
          rules: [{ conditions: { all: [{ fact: "a", operator: "equal", value: true }] }, event: { type: "complete" } }],
        },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue", "complete"],
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("PULL WARNING");
    expect(output).toContain("not \"block\"");
  });

  test("flags an unconditional-block default with no rules", () => {
    const step = makeStep({
      advancementPolicyDefinition: {
        rulesJson: { rules: [] },
        defaultEventType: "block",
        defaultEventParamsJson: null,
        allowedEventTypes: ["block"],
      },
    });

    const output = gen(makePipeline([step]));
    expect(output).toContain("PULL WARNING");
    expect(output).toContain("no equivalent");
  });
});
