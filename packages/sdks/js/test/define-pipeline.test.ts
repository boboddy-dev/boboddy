import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineStep } from "../src/definitions/steps/define-step";
import { definePipeline, Rule } from "../src/definitions/pipelines/define-pipeline";
import type {
  ChoiceNodeDefinitionSpec,
  StepNodeDefinitionSpec,
} from "../src/definitions/pipelines/define-pipeline";

const analyzeStep = defineStep({
  key: "analyze-step",
  name: "Analyze",
  agentPrompt: "Analyze the work item.",
  result: z.object({ severity: z.string(), confidence: z.number() }),
  signals: [
    { sourcePath: "severity", key: "severity" },
    { sourcePath: "confidence", key: "confidence", type: "number" },
  ],
});

const reviewStep = defineStep({
  key: "review-step",
  name: "Review",
  agentPrompt: "Review one file.",
  result: z.object({ passed: z.boolean() }),
  signals: [{ sourcePath: "passed", key: "passed", type: "boolean" }],
});

const pageOncallStep = defineStep({
  key: "page-oncall-step",
  name: "Page Oncall",
  agentPrompt: "Page the on-call engineer.",
});

describe("definePipeline — step", () => {
  test.concurrent("compiles a step -> step chain with an edge", () => {
    const spec = definePipeline({
      key: "chain",
      startAt: "analyze",
      states: {
        analyze: { kind: "step", step: analyzeStep, next: "review" },
        review: { kind: "step", step: reviewStep, next: "done" },
        done: { kind: "succeed" },
      },
    });

    expect(spec.nodeDefinitions.map((n) => n.nodeKey)).toEqual([
      "analyze",
      "review",
      "done",
    ]);
    expect(spec.dependencyEdges).toEqual([
      { fromNodeKey: "analyze", toNodeKey: "review" },
      { fromNodeKey: "review", toNodeKey: "done" },
    ]);
  });

  test.concurrent("blockWhen compiles to a block rule with a continue default", () => {
    const spec = definePipeline({
      key: "block-test",
      startAt: "analyze",
      states: {
        analyze: {
          kind: "step",
          step: analyzeStep,
          blockWhen: Rule.when("confidence", "lessThan", 7),
          next: "done",
        },
        done: { kind: "succeed" },
      },
    });

    const node = spec.nodeDefinitions.find(
      (n): n is StepNodeDefinitionSpec => n.nodeKey === "analyze" && n.kind === "step",
    );
    expect(node?.advancementPolicyDefinition.defaultEventType).toBe(
      "continue",
    );
    expect(node?.advancementPolicyDefinition.allowedEventTypes).toContain(
      "continue",
    );
    expect(node?.advancementPolicyDefinition.allowedEventTypes).toContain(
      "block",
    );
    expect(node?.advancementPolicyDefinition.rulesJson.rules).toHaveLength(1);
    expect(node?.advancementPolicyDefinition.rulesJson.rules[0]).toMatchObject({
      conditions: { all: [{ fact: "confidence", operator: "lessThan", value: 7 }] },
      event: { type: "block" },
    });
  });

  test.concurrent("next: { routeToPipeline } compiles to a route default outcome with no edge", () => {
    const spec = definePipeline({
      key: "router",
      startAt: "analyze",
      states: {
        analyze: {
          kind: "step",
          step: analyzeStep,
          next: { routeToPipeline: "other-pipeline" },
        },
      },
    });

    const node = spec.nodeDefinitions.find(
      (n): n is StepNodeDefinitionSpec => n.kind === "step",
    );
    expect(node?.advancementPolicyDefinition.defaultEventType).toBe("route");
    expect(node?.advancementPolicyDefinition.defaultEventParamsJson).toEqual({
      pipelineKey: "other-pipeline",
    });
    expect(spec.dependencyEdges).toEqual([]);
  });

  test.concurrent("input mapper bindings are serialized, plus auto workItem bindings", () => {
    const spec = definePipeline({
      key: "input-test",
      startAt: "analyze",
      states: {
        analyze: {
          kind: "step",
          step: analyzeStep,
          input: (ctx) => ({ diff: ctx.pipelineInput("diff") }),
          next: "done",
        },
        done: { kind: "succeed" },
      },
    });

    const node = spec.nodeDefinitions.find(
      (n): n is StepNodeDefinitionSpec => n.nodeKey === "analyze" && n.kind === "step",
    );
    expect(node?.inputBindingsJson).toMatchObject({
      workItemTitle: { source: "work_item", field: "title" },
      workItemDescription: { source: "work_item", field: "description" },
      diff: { source: "pipeline_input", path: "diff" },
    });
  });

  test.concurrent("ctx.signal/output/signalsList address producer nodes by state key", () => {
    const spec = definePipeline({
      key: "cross-node",
      startAt: "analyze",
      states: {
        analyze: { kind: "step", step: analyzeStep, next: "review" },
        review: {
          kind: "step",
          step: reviewStep,
          input: (ctx) => ({
            severity: ctx.signal("analyze", "severity"),
          }),
          next: "done",
        },
        done: { kind: "succeed" },
      },
    });

    const node = spec.nodeDefinitions.find(
      (n): n is StepNodeDefinitionSpec => n.nodeKey === "review" && n.kind === "step",
    );
    expect(node?.inputBindingsJson["severity"]).toEqual({
      source: "step_signal",
      stepKey: "analyze",
      signalKey: "severity",
    });
  });
});

describe("definePipeline — choice", () => {
  test.concurrent("compiles choices + default, with discriminant edges", () => {
    const spec = definePipeline({
      key: "choice-test",
      startAt: "analyze",
      states: {
        analyze: { kind: "step", step: analyzeStep, next: "routeBySeverity" },
        routeBySeverity: {
          kind: "choice",
          choices: [
            { when: Rule.when("severity", "equal", "critical"), next: "pageOncall" },
          ],
          default: "done",
        },
        // A different terminal than `default`'s target: `pageOncall`'s own
        // unconditional `next` can't converge with `default`'s edge onto the
        // same target (only choice/loop sources may converge — see §6).
        pageOncall: { kind: "step", step: pageOncallStep, next: "escalated" },
        escalated: { kind: "fail" },
        done: { kind: "succeed" },
      },
    });

    const choiceNode = spec.nodeDefinitions.find(
      (n): n is ChoiceNodeDefinitionSpec =>
        n.nodeKey === "routeBySeverity" && n.kind === "choice",
    );
    expect(choiceNode?.kind).toBe("choice");
    expect(choiceNode?.choices).toEqual([
      {
        conditionJson: { fact: "severity", operator: "equal", value: "critical" },
        targetNodeKey: "pageOncall",
      },
    ]);
    expect(choiceNode?.default).toBe("done");

    const edgesFromChoice = spec.dependencyEdges.filter(
      (e) => e.fromNodeKey === "routeBySeverity",
    );
    expect(edgesFromChoice).toHaveLength(2);
    expect(edgesFromChoice.map((e) => e.toNodeKey).sort()).toEqual([
      "done",
      "pageOncall",
    ]);
  });

  test.concurrent("requires at least one choice or a default", () => {
    expect(() =>
      definePipeline({
        key: "empty-choice",
        startAt: "start",
        states: {
          start: { kind: "step", step: analyzeStep, next: "gate" },
          gate: { kind: "choice", choices: [] },
        },
      }),
    ).toThrow(/requires at least one entry in choices or a default/);
  });

  test.concurrent("startAt cannot name a choice/succeed/fail state", () => {
    expect(() =>
      definePipeline({
        key: "bad-start",
        startAt: "gate",
        states: {
          gate: { kind: "choice", default: "done" },
          done: { kind: "succeed" },
        },
      }),
    ).toThrow(/cannot be an entry point/);
  });
});
