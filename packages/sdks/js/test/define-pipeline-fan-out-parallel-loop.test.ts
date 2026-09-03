import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineStep } from "../src/definitions/steps/define-step";
import { definePipeline, Rule } from "../src/definitions/pipelines/define-pipeline";
import type {
  FanOutNodeDefinitionSpec,
  LoopNodeDefinitionSpec,
  ParallelNodeDefinitionSpec,
} from "../src/definitions/pipelines/define-pipeline";

const analyzeStep = defineStep({
  key: "analyze-step",
  name: "Analyze",
  agentPrompt: "Analyze the work item.",
  result: z.object({ severity: z.string(), confidence: z.number() }),
  signals: [{ sourcePath: "severity", key: "severity" }],
});

const reviewStep = defineStep({
  key: "review-step",
  name: "Review",
  agentPrompt: "Review one file.",
  result: z.object({ passed: z.boolean() }),
  signals: [{ sourcePath: "passed", key: "passed", type: "boolean" }],
});

describe("definePipeline — fanOut", () => {
  test.concurrent("synthesizes the fanOut/cohortGate pair with two edges", () => {
    const spec = definePipeline({
      key: "fan-out-test",
      startAt: "analyze",
      states: {
        analyze: { kind: "step", step: analyzeStep, next: "fanOutFiles" },
        fanOutFiles: {
          kind: "fanOut",
          step: reviewStep,
          over: "analyze.changedFiles",
          maxConcurrency: 4,
          input: (ctx) => ({ file: ctx.item }),
          advanceEach: () => ({ default: "continue" }),
          advanceAll: (ctx) => ({
            default: "block",
            rules: [ctx.branchOutcomes.every("continue").then("continue")],
          }),
          next: "done",
        },
        done: { kind: "succeed" },
      },
    });

    const nodeKeys = spec.nodeDefinitions.map((n) => n.nodeKey);
    expect(nodeKeys).toContain("fanOutFiles");
    expect(nodeKeys).toContain("fanOutFiles__cohortGate");

    const fanOutNode = spec.nodeDefinitions.find(
      (n): n is FanOutNodeDefinitionSpec =>
        n.nodeKey === "fanOutFiles" && n.kind === "fanOut",
    );
    expect(fanOutNode?.overSignalKey).toBe("changedFiles");
    expect(fanOutNode?.maxConcurrency).toBe(4);

    expect(spec.dependencyEdges).toContainEqual({
      fromNodeKey: "fanOutFiles",
      toNodeKey: "fanOutFiles__cohortGate",
    });
    expect(spec.dependencyEdges).toContainEqual({
      fromNodeKey: "fanOutFiles__cohortGate",
      toNodeKey: "done",
    });
  });

  test.concurrent("rejects a synthesized cohortGate key colliding with an author state", () => {
    expect(() =>
      definePipeline({
        key: "collide",
        startAt: "fanOutFiles",
        states: {
          fanOutFiles: {
            kind: "fanOut",
            step: reviewStep,
            over: "count",
            advanceEach: () => ({ default: "continue" }),
            advanceAll: () => ({ default: "continue" }),
            next: "done",
          },
          "fanOutFiles__cohortGate": { kind: "succeed" },
          done: { kind: "succeed" },
        },
      }),
    ).toThrow(/collides with an author-declared state/);
  });
});

describe("definePipeline — parallel", () => {
  test.concurrent("compiles named branches and registers each branch's step", () => {
    const spec = definePipeline({
      key: "parallel-test",
      startAt: "gather",
      states: {
        gather: {
          kind: "parallel",
          branches: {
            reviewA: { step: reviewStep },
            reviewB: { step: reviewStep },
          },
          advanceAll: () => ({ default: "continue" }),
          next: "done",
        },
        done: { kind: "succeed" },
      },
    });

    const node = spec.nodeDefinitions.find(
      (n): n is ParallelNodeDefinitionSpec =>
        n.nodeKey === "gather" && n.kind === "parallel",
    );
    expect(node?.kind).toBe("parallel");
    expect(Object.keys(node?.branches ?? {})).toEqual(["reviewA", "reviewB"]);
    expect(spec._stepDefinitions?.map((s) => s.key)).toContain("review-step");
  });

  test.concurrent("requires at least one branch", () => {
    expect(() =>
      definePipeline({
        key: "empty-parallel",
        startAt: "gather",
        states: {
          gather: { kind: "parallel", branches: {}, next: "done" },
          done: { kind: "succeed" },
        },
      }),
    ).toThrow(/requires at least one branch/);
  });
});

describe("definePipeline — loop", () => {
  test.concurrent("compiles maxIterations/until and both discriminant edges", () => {
    const spec = definePipeline({
      key: "loop-test",
      startAt: "refine",
      states: {
        refine: {
          kind: "loop",
          step: reviewStep,
          maxIterations: 5,
          until: Rule.when("passed", "equal", true),
          next: "publish",
          onExhausted: "escalate",
        },
        publish: { kind: "succeed" },
        escalate: { kind: "fail" },
      },
    });

    const node = spec.nodeDefinitions.find(
      (n): n is LoopNodeDefinitionSpec => n.nodeKey === "refine" && n.kind === "loop",
    );
    expect(node?.maxIterations).toBe(5);
    expect(node?.untilConditionJson).toEqual({
      fact: "passed",
      operator: "equal",
      value: true,
    });

    expect(spec.dependencyEdges).toContainEqual({
      fromNodeKey: "refine",
      toNodeKey: "publish",
      discriminantJson: { loopExit: "next" },
    });
    expect(spec.dependencyEdges).toContainEqual({
      fromNodeKey: "refine",
      toNodeKey: "escalate",
      discriminantJson: { loopExit: "onExhausted" },
    });
  });
});

describe("definePipeline — convergent edges", () => {
  test.concurrent("allows two choice branches converging on one shared target", () => {
    expect(() =>
      definePipeline({
        key: "converge-ok",
        startAt: "start",
        states: {
          start: { kind: "step", step: analyzeStep, next: "gate" },
          gate: {
            kind: "choice",
            choices: [
              { when: Rule.when("a", "equal", true), next: "shared" },
              { when: Rule.when("b", "equal", true), next: "shared" },
            ],
            default: "shared",
          },
          shared: { kind: "succeed" },
        },
      }),
    ).not.toThrow();
  });

  test.concurrent("allows two unconditional steps converging on one shared target", () => {
    expect(() =>
      definePipeline({
        key: "converge-bad",
        startAt: "a",
        states: {
          a: { kind: "step", step: analyzeStep, next: "shared" },
          b: { kind: "step", step: reviewStep, next: "shared" },
          shared: { kind: "succeed" },
        },
      }),
    ).not.toThrow();
  });
});

describe("definePipeline — misc", () => {
  test.concurrent("rejects an unknown startAt", () => {
    expect(() =>
      definePipeline({
        key: "bad",
        startAt: "does-not-exist",
        states: { a: { kind: "succeed" } },
      }),
    ).toThrow(/does not name a declared state/);
  });

  test.concurrent("rejects a target that does not exist", () => {
    expect(() =>
      definePipeline({
        key: "dangling",
        startAt: "a",
        states: {
          a: { kind: "step", step: analyzeStep, next: "nowhere" },
        },
      }),
    ).toThrow(/targets unknown state "nowhere"/);
  });

  test.concurrent("defaults name to key, version to 1, status to active", () => {
    const spec = definePipeline({
      key: "defaults-test",
      startAt: "start",
      states: {
        start: { kind: "step", step: analyzeStep, next: "done" },
        done: { kind: "succeed" },
      },
    });
    expect(spec.name).toBe("defaults-test");
    expect(spec.version).toBe(1);
    expect(spec.status).toBe("active");
  });

  test.concurrent("entryNodeKey round-trips from config.startAt", () => {
    const spec = definePipeline({
      key: "entry-node-key-test",
      startAt: "review",
      states: {
        review: { kind: "step", step: reviewStep, next: "done" },
        done: { kind: "succeed" },
      },
    });
    expect(spec.entryNodeKey).toBe("review");
  });
});
