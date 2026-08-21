import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { pipeline } from "../src/definitions/pipelines/builder";
import { defineStep } from "../src/definitions/steps/define-step";

const triageStep = defineStep({
  key: "triage",
  name: "Triage",
  agentPrompt: "Triage the issue and decide how many reviewers to fan out to.",
  result: z.object({ reviewerCount: z.number() }),
  signals: [{ sourcePath: "reviewerCount", key: "reviewer_count" }],
});

const reviewStep = defineStep({
  key: "review",
  name: "Review",
  agentPrompt: "Review the issue and report your confidence.",
  result: z.object({ confidence: z.number(), passed: z.boolean() }),
  signals: [{ sourcePath: "confidence" }, { sourcePath: "passed" }],
});

const reportStep = defineStep({
  key: "report",
  name: "Report",
  agentPrompt: "Summarize the cohort's reviews.",
  result: z.object({ summary: z.string() }),
  signals: [{ sourcePath: "summary" }],
});

/**
 * `.fanOutStep()` (issue #167). `advance`/`advanceAll` live inline in the
 * `.fanOutStep()` config object (mirroring `.step()`'s `advance` option)
 * rather than as separate chained calls. Mirrors the existing
 * `pipeline-builder-advanced.test.ts`/`pipeline-builder-extras.test.ts`
 * style: build a real spec through the public builder, then assert on the
 * compiled `PipelineDefinitionSpec` shape.
 */
describe("pipeline() builder — .fanOutStep()", () => {
  test.concurrent(
    "compiles to fanOut + cohortGate node definitions, paired consecutively (AC1)",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          advance: () => ({ default: "continue" }),
          advanceAll: () => ({ default: "continue" }),
        })
        .build();

      // .fanOutStep() itself appends nothing to the step sequence beyond
      // the fanOut+cohortGate pair — exactly 3 nodes total.
      expect(spec.nodeDefinitions.map((n) => n.kind)).toEqual([
        "step",
        "fanOut",
        "cohortGate",
      ]);

      const [triageNode, fanOutNode, cohortGateNode] = spec.nodeDefinitions;
      expect(fanOutNode).toMatchObject({
        kind: "fanOut",
        nodeKey: "review",
        stepKey: "review",
        overSignalKey: "reviewer_count",
      });
      expect(cohortGateNode).toMatchObject({
        kind: "cohortGate",
        nodeKey: "review__cohortGate",
      });

      // buildChainDependencyEdges synthesizes fanOut -> cohortGate for free
      // from declaration order, same as any other consecutive pair.
      expect(spec.dependencyEdges).toEqual([
        { fromNodeKey: "triage", toNodeKey: "review" },
        { fromNodeKey: "review", toNodeKey: "review__cohortGate" },
      ]);
      expect(triageNode?.kind).toBe("step");
    },
  );

  test.concurrent(
    "a step after .fanOutStep() is wired as the cohortGate's successor",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          advance: () => ({ default: "continue" }),
          advanceAll: () => ({ default: "continue" }),
        })
        .step(reportStep, { advance: () => ({ default: "continue" }) })
        .build();

      expect(spec.nodeDefinitions.map((n) => n.kind)).toEqual([
        "step",
        "fanOut",
        "cohortGate",
        "step",
      ]);
      expect(spec.dependencyEdges).toEqual([
        { fromNodeKey: "triage", toNodeKey: "review" },
        { fromNodeKey: "review", toNodeKey: "review__cohortGate" },
        { fromNodeKey: "review__cohortGate", toNodeKey: "report" },
      ]);
    },
  );

  test.concurrent(
    "advance's rules serialize against the branch's own signals",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          // eslint-disable-next-line @typescript-eslint/unbound-method
          advance: ({ signal }) => ({
            default: "continue",
            rules: [signal("passed").eq(false).then("block")],
          }),
          advanceAll: () => ({ default: "continue" }),
        })
        .build();

      const fanOutNode = spec.nodeDefinitions[1];
      expect(fanOutNode?.advanceEachPolicyDefinition).toEqual({
        rules: [
          {
            conditions: {
              all: [{ fact: "passed", operator: "equal", value: false }],
            },
            event: { type: "block" },
          },
        ],
        defaultEventType: "continue",
        defaultEventParamsJson: null,
      });
    },
  );

  test.concurrent(
    "branchOutcomes.total()/.count()/.every()/.some() compile to the expected facts",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          advance: () => ({ default: "continue" }),
          // eslint-disable-next-line @typescript-eslint/unbound-method
          advanceAll: ({ branchOutcomes, all }) => ({
            default: "block",
            rules: [
              all(
                branchOutcomes.total().gte(1),
                branchOutcomes.count("block").eq(0),
              ).then("continue"),
              branchOutcomes.every("continue").then("continue"),
              branchOutcomes.some("error").then("block"),
            ],
          }),
        })
        .build();

      const cohortGateNode = spec.nodeDefinitions[2];
      expect(cohortGateNode?.advanceAllPolicyDefinition).toEqual({
        rules: [
          {
            conditions: {
              all: [
                {
                  fact: "branchCount",
                  operator: "greaterThanInclusive",
                  value: 1,
                },
                { fact: "blockCount", operator: "equal", value: 0 },
              ],
            },
            event: { type: "continue" },
          },
          {
            conditions: {
              all: [
                {
                  fact: "continueCount",
                  operator: "equal",
                  value: { fact: "branchCount" },
                },
              ],
            },
            event: { type: "continue" },
          },
          {
            conditions: {
              all: [{ fact: "errorCount", operator: "greaterThan", value: 0 }],
            },
            event: { type: "block" },
          },
        ],
        defaultEventType: "block",
        defaultEventParamsJson: null,
      });
    },
  );

  test.concurrent(
    "ctx.stepSignalsList hoists into stepSignalsListDefinitions on the cohortGate node",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          advance: () => ({ default: "continue" }),
          advanceAll: ({ stepSignalsList }) => ({
            default: "block",
            rules: [
              stepSignalsList
                .pluck("confidence")
                .avg()
                .gte(0.5)
                .then("continue"),
            ],
          }),
        })
        .build();

      const cohortGateNode = spec.nodeDefinitions[2];
      expect(cohortGateNode?.stepSignalsListDefinitions).toEqual([
        {
          key: "avg_confidence",
          ops: [{ op: "pluck", signalKey: "confidence" }],
          reducer: { op: "avg" },
        },
      ]);
      expect(cohortGateNode?.advanceAllPolicyDefinition).toMatchObject({
        rules: [
          {
            conditions: {
              all: [
                {
                  fact: "avg_confidence",
                  operator: "greaterThanInclusive",
                  value: 0.5,
                },
              ],
            },
            event: { type: "continue" },
          },
        ],
      });
    },
  );

  test.concurrent(
    "ctx.stepSignalsList supports filter/sortBy/unique before reducing",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          advance: () => ({ default: "continue" }),
          advanceAll: ({ stepSignalsList }) => ({
            default: "continue",
            rules: [
              stepSignalsList
                .pluck("confidence")
                .filter("greaterThanInclusive", 0.5)
                .sortBy("desc")
                .unique()
                .count()
                .gte(1)
                .then("block"),
            ],
          }),
        })
        .build();

      const cohortGateNode = spec.nodeDefinitions[2];
      expect(cohortGateNode?.stepSignalsListDefinitions).toEqual([
        {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          key: expect.stringContaining("count_confidence"),
          ops: [
            { op: "pluck", signalKey: "confidence" },
            { op: "filter", operator: "greaterThanInclusive", value: 0.5 },
            { op: "sortBy", direction: "desc" },
            { op: "unique" },
          ],
          reducer: { op: "count" },
        },
      ]);
    },
  );

  test.concurrent(
    "ctx.signalsList(fanOutStep) works from a non-adjacent later step (AC3)",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          advance: () => ({ default: "continue" }),
          advanceAll: () => ({ default: "continue" }),
        })
        .step(reportStep, {
          input: ({ signalsList }) => ({ reviews: signalsList(reviewStep) }),
          advance: () => ({ default: "continue" }),
        })
        .build();

      const reportNode = spec.nodeDefinitions[3];
      expect(reportNode?.inputBindingsJson?.["reviews"]).toEqual({
        source: "signals_list",
        stepKey: "review",
      });
    },
  );

  test.concurrent(
    ".fanOutStep()'s own input mapper serializes bindings",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          input: ({ literal }) => ({ mode: literal("thorough") }),
          timeout: 900,
          advance: () => ({ default: "continue" }),
          advanceAll: () => ({ default: "continue" }),
        })
        .build();

      const fanOutNode = spec.nodeDefinitions[1];
      expect(fanOutNode?.inputBindingsJson?.["mode"]).toEqual({
        source: "literal",
        value: "thorough",
      });
      expect(fanOutNode?.timeoutSeconds).toBe(900);
    },
  );

  // `packages/sdks/js/tsconfig.json` includes `test/**/*.ts`, so every
  // `@ts-expect-error` below IS the assertion: `bun run typecheck` fails if
  // the error it claims stops being reported (same discipline as
  // `define-step.test.ts`'s sourcePath type-level tests).
  describe("advance's outcome domain is restricted to continue | block only (AC4)", () => {
    test("rejects a 'route' default outcome", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          // @ts-expect-error "route" is not part of advance's continue|block domain.
          advance: () => ({ default: "route" }),
          advanceAll: () => ({ default: "continue" }),
        })
        .build();

      // The type error is the point; the runtime is unchanged. Cast away
      // the (now-inaccurate, since the type error was suppressed above)
      // `SerializedCohortAdvancementPolicy["defaultEventType"]` narrowing
      // so this assertion on the deliberately-invalid runtime value
      // type-checks.
      const policy = spec.nodeDefinitions[1]
        ?.advanceEachPolicyDefinition as unknown;
      expect(policy).toEqual({
        rules: [],
        defaultEventType: "route",
        defaultEventParamsJson: null,
      });
    });

    test("rejects a 'complete' outcome on a rule's .then()", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          // eslint-disable-next-line @typescript-eslint/unbound-method
          advance: ({ signal }) => ({
            default: "continue",
            // @ts-expect-error "complete" is not part of advance's continue|block domain.
            rules: [signal("passed").eq(false).then("complete")],
          }),
          advanceAll: () => ({ default: "continue" }),
        })
        .build();

      const eventType = spec.nodeDefinitions[1]?.advanceEachPolicyDefinition
        ?.rules[0]?.event.type as unknown;
      expect(eventType).toBe("complete");
    });

    test("advanceAll's outcome domain is likewise restricted to continue | block", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          advance: () => ({ default: "continue" }),
          // @ts-expect-error "route" is not part of advanceAll's continue|block domain.
          advanceAll: () => ({ default: "route" }),
        })
        .build();

      const policy = spec.nodeDefinitions[2]
        ?.advanceAllPolicyDefinition as unknown;
      expect(policy).toEqual({
        rules: [],
        defaultEventType: "route",
        defaultEventParamsJson: null,
      });
    });

    test("advance's ctx has no avg/sum computed-signal factories (unlike a regular step's .advance())", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(triageStep, { advance: () => ({ default: "continue" }) })
        .fanOutStep(reviewStep, {
          over: "reviewer_count",
          advance: (ctx) => {
            // @ts-expect-error `avg` does not exist on `AdvanceEachCtx` — core
            // has no mechanism yet to resolve a computed signal for a fanOut
            // node's advance policy (see cohort-fluent-rules.ts).
            void ctx.avg;
            return { default: "continue" };
          },
          advanceAll: () => ({ default: "continue" }),
        })
        .build();

      expect(spec.nodeDefinitions[1]?.kind).toBe("fanOut");
    });
  });
});
