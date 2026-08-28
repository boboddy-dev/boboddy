import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { pipeline } from "../src/definitions/pipelines/builder";
import {
  defaultPipelineAssignment,
  serializeDefaultPipelineAssignment,
  type AssignmentLeaf,
  type WorkItemAssignmentAccessor,
} from "../src/definitions/pipelines/define-default-pipeline-assignment";
import {
  WORK_ITEM_TOP_LEVEL_FIELDS,
  type WorkItemTopLevelField,
} from "../src/definitions/pipelines/work-item-fields";
import { defineStep } from "../src/definitions/steps/define-step";

const triageStep = defineStep({
  key: "triage",
  name: "Triage",
  agentPrompt: "Triage the incoming work item.",
  result: z.object({ ok: z.boolean() }),
  signals: [{ sourcePath: "ok" }],
});

const triagePipeline = pipeline({ key: "triage-and-plan", name: "Triage and Plan" })
  .step(triageStep, {
    advance: () => ({ default: "continue" }),
  })
  .build();

describe("defaultPipelineAssignment / assign()", () => {
  test.concurrent("assign() accepts a real pipeline().build() output", () => {
    const spec = defaultPipelineAssignment(({ assign }) => ({
      default: assign(triagePipeline),
      rules: [],
    }));

    expect(spec.default).toEqual({ _tag: "assign", pipeline: triagePipeline });
  });

  test.concurrent("assign() rejects a non-pipeline value", () => {
    expect(() =>
      defaultPipelineAssignment(({ assign }) => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        default: assign({ key: "not-a-pipeline" } as any),
        rules: [],
      })),
    ).toThrow(/assign\(\) requires a pipeline spec produced by pipeline\(\)\.build\(\)/);
  });

  test.concurrent("assign() works inside a rule's .then()", () => {
    const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => ({
      default: skip(),
      rules: [
        workItem.field("issueType").eq("bug").then(assign(triagePipeline)),
      ],
    }));

    expect(spec.rules[0]?.outcome).toEqual({
      _tag: "assign",
      pipeline: triagePipeline,
    });
  });
});

describe("defaultPipelineAssignment / workItem top-level properties", () => {
  test.concurrent(
    "workItem.field(name) still serializes to a $.fields.<name> path",
    () => {
      const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [
          workItem.field("issueType").eq("bug").then(assign(triagePipeline)),
        ],
      }));

      const serialized = serializeDefaultPipelineAssignment(spec);
      expect(serialized.rulesJson.rules[0]?.conditions).toEqual({
        all: [
          {
            fact: "workItem",
            path: "$.fields.issueType",
            operator: "equal",
            value: "bug",
          },
        ],
      });
    },
  );

  test.concurrent(
    "workItem.title serializes to a top-level $.title path (not $.fields.title)",
    () => {
      const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [
          workItem
            .title.contains("[urgent]")
            .then(assign(triagePipeline)),
        ],
      }));

      const serialized = serializeDefaultPipelineAssignment(spec);
      expect(serialized.rulesJson.rules[0]?.conditions).toEqual({
        all: [
          {
            fact: "workItem",
            path: "$.title",
            operator: "contains",
            value: "[urgent]",
          },
        ],
      });
    },
  );

  /**
   * One valid sample value per field, matching each field's real type in
   * `WorkItemTopLevelFieldTypeMap` (e.g. `platform` only accepts one of its 5
   * literals, not an arbitrary string). Reusing one literal ("x") for every
   * field, as this test used to, no longer typechecks now that
   * `AssignmentFieldRef` is generic per field.
   *
   * This must be a `switch` (rather than indexing `workItem[field]` against a
   * same-keyed sample-value map): TypeScript does not correlate two separately
   * *computed* indexed-access expressions sharing a union-typed `field`
   * variable — `workItem[field]` and `sampleValues[field]` each independently
   * widen to the union over every field's type, so `.eq(...)` sees an
   * unsatisfiable intersection of parameter types. A `switch` over the
   * (unioned) `field` literal narrows it per-case, which is what lets
   * TypeScript pick the one correct `AssignmentFieldRef<T>` and its matching
   * sample value together. Missing a case here is a compile error (the
   * function's return type isn't satisfied), so this can't silently drift
   * from `WORK_ITEM_TOP_LEVEL_FIELDS`.
   */
  function sampleRuleFor(
    workItem: WorkItemAssignmentAccessor,
    field: WorkItemTopLevelField,
  ): { leaf: AssignmentLeaf; value: unknown } {
    switch (field) {
      case "id":
        return { leaf: workItem.id.eq("id-x"), value: "id-x" };
      case "projectId":
        return { leaf: workItem.projectId.eq("project-x"), value: "project-x" };
      case "platform":
        return { leaf: workItem.platform.eq("github"), value: "github" };
      case "platformId":
        return {
          leaf: workItem.platformId.eq("platform-id-x"),
          value: "platform-id-x",
        };
      case "platformKey":
        return { leaf: workItem.platformKey.eq("PROJ-1"), value: "PROJ-1" };
      case "url":
        return {
          leaf: workItem.url.eq("https://example.test/x"),
          value: "https://example.test/x",
        };
      case "title":
        return { leaf: workItem.title.eq("x"), value: "x" };
      case "description":
        return { leaf: workItem.description.eq("x"), value: "x" };
      case "sourceCreatedAt":
        return {
          leaf: workItem.sourceCreatedAt.eq("2026-01-01T00:00:00.000Z"),
          value: "2026-01-01T00:00:00.000Z",
        };
      case "sourceUpdatedAt":
        return {
          leaf: workItem.sourceUpdatedAt.eq("2026-01-01T00:00:00.000Z"),
          value: "2026-01-01T00:00:00.000Z",
        };
      case "createdByUserId":
        return {
          leaf: workItem.createdByUserId.eq("user-x"),
          value: "user-x",
        };
      case "parentWorkItemId":
        return {
          leaf: workItem.parentWorkItemId.eq("parent-x"),
          value: "parent-x",
        };
      case "createdAt":
        return {
          leaf: workItem.createdAt.eq("2026-01-01T00:00:00.000Z"),
          value: "2026-01-01T00:00:00.000Z",
        };
      case "updatedAt":
        return {
          leaf: workItem.updatedAt.eq("2026-01-01T00:00:00.000Z"),
          value: "2026-01-01T00:00:00.000Z",
        };
    }
  }

  test.concurrent(
    "every declared top-level field is reachable on ctx.workItem and serializes to $.<field>",
    () => {
      for (const field of WORK_ITEM_TOP_LEVEL_FIELDS) {
        let expectedValue: unknown;
        const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => {
          const { leaf, value } = sampleRuleFor(workItem, field);
          expectedValue = value;
          return { default: skip(), rules: [leaf.then(assign(triagePipeline))] };
        });

        const serialized = serializeDefaultPipelineAssignment(spec);
        expect(serialized.rulesJson.rules[0]?.conditions).toEqual({
          all: [
            {
              fact: "workItem",
              path: `$.${field}`,
              operator: "equal",
              value: expectedValue,
            },
          ],
        });
      }
    },
  );

  test.concurrent("context.isNew still serializes to $.isNew on the context fact", () => {
    const spec = defaultPipelineAssignment(({ context, assign, skip }) => ({
      default: skip(),
      rules: [context.isNew.eq(true).then(assign(triagePipeline))],
    }));

    const serialized = serializeDefaultPipelineAssignment(spec);
    expect(serialized.rulesJson.rules[0]?.conditions).toEqual({
      all: [{ fact: "context", path: "$.isNew", operator: "equal", value: true }],
    });
  });
});

// `packages/sdks/js/tsconfig.json` includes `test/**/*.ts`, so every
// `@ts-expect-error` below IS the assertion: `bun run typecheck` fails if the
// error it claims stops being reported (same discipline as
// `pipeline-builder-fan-out.test.ts`'s advance-outcome-domain tests).
describe("defaultPipelineAssignment / per-field typing (AssignmentFieldRef<T>)", () => {
  test.concurrent(
    "workItem.platform.eq('github') is a valid literal and serializes correctly",
    () => {
      const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [workItem.platform.eq("github").then(assign(triagePipeline))],
      }));

      const serialized = serializeDefaultPipelineAssignment(spec);
      expect(serialized.rulesJson.rules[0]?.conditions).toEqual({
        all: [
          { fact: "workItem", path: "$.platform", operator: "equal", value: "github" },
        ],
      });
    },
  );

  test.concurrent(
    "workItem.platform.eq(...) rejects a value outside the 5-platform literal union",
    () => {
      defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [
          // @ts-expect-error "not-a-real-platform" is not a member of WorkItemPlatformLiteral.
          workItem.platform.eq("not-a-real-platform").then(assign(triagePipeline)),
        ],
      }));
    },
  );

  test.concurrent(
    "workItem.title has no numeric comparators (.gt/.gte/.lt/.lte) since title: string",
    () => {
      defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        rules: [
          // @ts-expect-error `gt` does not exist on AssignmentFieldRef<string> — title is not numeric.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          workItem.title.gt(5).then(assign(triagePipeline)),
        ],
      }));
    },
  );

  test.concurrent(
    "workItem.field(name) stays untyped by default (backward-compatible) with no type arguments",
    () => {
      const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [
          workItem.field("issueType").eq("bug").then(assign(triagePipeline)),
          workItem
            .field<string, number>("storyPoints")
            .gte(3)
            .then(assign(triagePipeline)),
        ],
      }));

      expect(spec.rules).toHaveLength(2);
    },
  );

  // Proves the mechanism `boboddy pipelines pull`'s generated
  // `WorkItemFieldName` (see `work-item-fields-file-generator.ts`) relies on:
  // `.field<TName>(name)`'s FIRST type parameter constrains the `name`
  // argument itself, not the comparator value — so passing a project-specific
  // literal union as `TName` rejects an unknown field name at compile time,
  // while `.eq(...)` stays untyped (`TValue` defaults to `unknown`) unless a
  // second type argument is also supplied.
  test.concurrent(
    "workItem.field<TName>(name) constrains the field NAME to a hand-declared literal union",
    () => {
      type SampleWorkItemFieldName = "issueType" | "status";

      const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [
          // TName is constrained; TValue defaults to unknown, so any value
          // (including one that isn't itself a SampleWorkItemFieldName) is
          // still accepted by .eq(...) here — this is the documented usage.
          workItem
            .field<SampleWorkItemFieldName>("issueType")
            .eq("bug")
            .then(assign(triagePipeline)),
        ],
      }));
      expect(spec.rules).toHaveLength(1);

      defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [
          workItem
            // @ts-expect-error "typo-field" is not a member of SampleWorkItemFieldName.
            .field<SampleWorkItemFieldName>("typo-field")
            .eq("x")
            .then(assign(triagePipeline)),
        ],
      }));
    },
  );

  test.concurrent(
    "workItem.field<TName, TValue>(name) also constrains the comparator value when supplied",
    () => {
      const spec = defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [
          workItem
            .field<string, number>("storyPoints")
            .gte(3)
            .then(assign(triagePipeline)),
        ],
      }));
      expect(spec.rules).toHaveLength(1);

      defaultPipelineAssignment(({ workItem, assign, skip }) => ({
        default: skip(),
        rules: [
          workItem
            .field<string, number>("storyPoints")
            // @ts-expect-error "not-a-number" is not assignable to TValue = number.
            .eq("not-a-number")
            .then(assign(triagePipeline)),
        ],
      }));
    },
  );
});
