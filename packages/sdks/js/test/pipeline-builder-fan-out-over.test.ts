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

const triageWithAssigneesStep = defineStep({
  key: "triage_assignees",
  name: "Triage assignees",
  agentPrompt: "Triage the issue and decide who should review it.",
  result: z.object({ assigneeIds: z.array(z.string()) }),
  signals: [{ sourcePath: "assigneeIds" }],
});

const assigneeReviewStep = defineStep({
  key: "assignee_review",
  name: "Assignee review",
  agentPrompt: "Review the issue as the assigned reviewer.",
  additionalInput: z.object({
    assigneeId: z.string(),
    ticketTitle: z.string(),
  }),
  result: z.object({ confidence: z.number(), passed: z.boolean() }),
  signals: [{ sourcePath: "confidence" }, { sourcePath: "passed" }],
});

const triageWithReviewerBriefsStep = defineStep({
  key: "triage_reviewer_briefs",
  name: "Triage reviewer briefs",
  agentPrompt: "Triage the issue and produce a brief for each reviewer.",
  result: z.object({
    reviewerBriefs: z.array(
      z.object({
        assigneeId: z.string(),
        priority: z.enum(["low", "medium", "high"]),
        focusAreas: z.array(z.string()),
      }),
    ),
  }),
  signals: [{ sourcePath: "reviewerBriefs" }],
});

const briefedReviewStep = defineStep({
  key: "briefed_review",
  name: "Briefed review",
  agentPrompt: "Review the issue using the assigned reviewer brief.",
  additionalInput: z.object({
    brief: z.object({
      assigneeId: z.string(),
      priority: z.enum(["low", "medium", "high"]),
      focusAreas: z.array(z.string()),
    }),
    ticketTitle: z.string(),
  }),
  result: z.object({ confidence: z.number(), passed: z.boolean() }),
  signals: [{ sourcePath: "confidence" }, { sourcePath: "passed" }],
});

/**
 * `pipeline() builder — .fanOutStep()` — `over` resolves branch
 * cardinality/item shape from the preceding step's signal — split out of
 * `pipeline-builder-fan-out.test.ts` to keep that file under the repo's
 * `max-lines` limit; see that file for the rest of `.fanOutStep()`'s own
 * coverage.
 */
describe("pipeline() builder — .fanOutStep()", () => {
  describe("over resolves branch cardinality/item shape from the preceding step's signal", () => {
    test.concurrent(
      "number-typed over: fixed branch count, no item on the input ctx (regression)",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(triageStep, { advance: () => ({ default: "continue" }) })
          .fanOutStep(reviewStep, {
            over: "reviewer_count",
            input: (ctx) => {
              // @ts-expect-error `item` does not exist on the input ctx when
              // `over` names a number-typed signal (count-only mode).
              void ctx.item;
              return {};
            },
            advance: () => ({ default: "continue" }),
            advanceAll: () => ({ default: "continue" }),
          })
          .build();

        const fanOutNode = spec.nodeDefinitions[1];
        expect(fanOutNode).toMatchObject({
          kind: "fanOut",
          overSignalKey: "reviewer_count",
        });
      },
    );

    test.concurrent(
      "array-typed over: item is typed as the array's element and serializes as a fan_out_item binding",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(triageWithAssigneesStep, {
            advance: () => ({ default: "continue" }),
          })
          .fanOutStep(assigneeReviewStep, {
            over: "assigneeIds",
            input: ({ item, input }) => {
              // `item`'s exposed type is the array's element type (`string`
              // here) intersected with the wire-level `fan_out_item`
              // binding — assignable to a plain `string`-typed slot...
              const asString: string = item;
              void asString;
              return {
                assigneeId: item,
                ticketTitle: input.workItemTitle,
              };
            },
            advance: () => ({ default: "continue" }),
            advanceAll: () => ({ default: "continue" }),
          })
          .build();

        const fanOutNode = spec.nodeDefinitions[1];
        expect(fanOutNode).toMatchObject({
          kind: "fanOut",
          overSignalKey: "assigneeIds",
        });
        expect(fanOutNode?.inputBindingsJson?.["assigneeId"]).toEqual({
          source: "fan_out_item",
        });
        expect(fanOutNode?.inputBindingsJson?.["ticketTitle"]).toEqual({
          source: "work_item",
          field: "title",
        });
      },
    );

    test.concurrent(
      "object-array-typed over: item is typed as the array's object element and still serializes as a single fan_out_item binding",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(triageWithReviewerBriefsStep, {
            advance: () => ({ default: "continue" }),
          })
          .fanOutStep(briefedReviewStep, {
            over: "reviewerBriefs",
            input: ({ item, input }) => {
              // `item`'s exposed type is the array's element type — here a
              // full object (`{ assigneeId, priority, focusAreas }`) rather
              // than a primitive — intersected with the wire-level
              // `fan_out_item` binding. The fan-out wire format has no
              // per-field path into the item, so the whole object is
              // assigned to a single object-typed input field...
              // const priority: "low" | "medium" | "high" = item.priority;
              // void priority;
              return {
                brief: item,
                ticketTitle: input.workItemTitle,
              };
            },
            advance: () => ({ default: "continue" }),
            advanceAll: () => ({ default: "continue" }),
          })
          .build();

        const fanOutNode = spec.nodeDefinitions[1];
        expect(fanOutNode).toMatchObject({
          kind: "fanOut",
          overSignalKey: "reviewerBriefs",
        });
        expect(fanOutNode?.inputBindingsJson?.["brief"]).toEqual({
          source: "fan_out_item",
        });
        expect(fanOutNode?.inputBindingsJson?.["ticketTitle"]).toEqual({
          source: "work_item",
          field: "title",
        });
      },
    );
  });
});
