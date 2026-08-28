import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";
import {
  defaultPipelineAssignment,
  pipeline,
  serializeDefaultPipelineAssignment,
  WORK_ITEM_TOP_LEVEL_FIELDS,
  type AssignmentLeaf,
  type WorkItemAssignmentAccessor,
  type WorkItemTopLevelField,
} from "@boboddy/sdk/definitions/pipelines";
import {
  generateDefaultPipelineAssignmentFileContent,
  UnsupportedRuleError,
  type DefaultPipelineAssignmentContract,
} from "../../../../src/pipelines/pipeline-definitions/infra/default-pipeline-assignment-file-generator";

const PIPELINE_DEFINITION_ID = "0196917c-532c-75aa-b7d5-0a84b71a1f99";

const triageStep = defineStep({
  key: "triage",
  name: "Triage",
  agentPrompt: "Triage the incoming work item.",
  result: z.object({ ok: z.boolean() }),
  signals: [{ sourcePath: "ok" }],
});

const triagePipeline = pipeline({ key: "triage-and-plan", name: "Triage and Plan" })
  .step(triageStep, { advance: () => ({ default: "continue" }) })
  .build();

const definitionIdToKey = new Map([[PIPELINE_DEFINITION_ID, "triage-and-plan"]]);

/**
 * Build the server contract exactly as `push` would produce it, by round-
 * tripping through the real SDK builder + serializer rather than
 * hand-writing the wire shape. This is what makes these tests a genuine
 * push -> serialize -> pull -> regenerate round trip.
 */
function contractFromSpec(
  build: Parameters<typeof defaultPipelineAssignment>[0],
): DefaultPipelineAssignmentContract {
  const spec = defaultPipelineAssignment(build);
  const serialized = serializeDefaultPipelineAssignment(spec);
  return {
    pipelineDefinitionId: PIPELINE_DEFINITION_ID,
    rulesJson: serialized.rulesJson,
    defaultEventType: serialized.defaultEventType,
    defaultEventParamsJson: serialized.defaultEventParamsJson,
    allowedEventTypes: serialized.allowedEventTypes,
  };
}

describe("generateDefaultPipelineAssignmentFileContent / workItem top-level fields", () => {
  test("reconstructs a top-level workItem.title condition as a property access, not workItem.field(...)", () => {
    const contract = contractFromSpec(({ workItem, assign, skip }) => ({
      default: skip(),
      rules: [
        workItem.title.contains("[urgent]").then(assign(triagePipeline)),
      ],
    }));

    const output = generateDefaultPipelineAssignmentFileContent(
      contract,
      definitionIdToKey,
    );

    expect(output).toContain('workItem.title.contains("[urgent]")');
    expect(output).not.toContain("workItem.field(");
    // Only the real module export belongs in the import statement.
    expect(output).toContain(
      'import { defaultPipelineAssignment } from "@boboddy/sdk/definitions/pipelines";',
    );
    expect(output).not.toMatch(/import\s*\{[^}]*workItem[^}]*\}\s*from\s*"@boboddy\/sdk/);
  });

  /**
   * One valid sample value per field, matching each field's real type now
   * that `AssignmentFieldRef` is generic per field (e.g. `platform` only
   * accepts one of its 5 literals — reusing one literal for every field, as
   * this test used to, no longer typechecks).
   *
   * This is a `switch` rather than an indexed sample-value map: TypeScript
   * does not correlate two separately *computed* indexed-access expressions
   * sharing a union-typed `field` variable (`workItem[field]` and
   * `sampleValues[field]` each independently widen to the union over every
   * field's type). A `switch` over the (unioned) `field` literal narrows it
   * per-case, which is what lets TypeScript pick the one correct
   * `AssignmentFieldRef<T>` and its matching sample value together — see the
   * identical pattern and rationale in
   * `packages/sdks/js/test/default-pipeline-assignment.test.ts`. Missing a
   * case is a compile error, so this can't silently drift from
   * `WORK_ITEM_TOP_LEVEL_FIELDS`.
   */
  function sampleRuleFor(
    workItem: WorkItemAssignmentAccessor,
    field: WorkItemTopLevelField,
  ): { leaf: AssignmentLeaf; value: string } {
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

  test("every top-level field round-trips through push -> serialize -> pull -> regenerate", () => {
    for (const field of WORK_ITEM_TOP_LEVEL_FIELDS) {
      let expectedValue = "";
      const contract = contractFromSpec(({ workItem, assign, skip }) => {
        const { leaf, value } = sampleRuleFor(workItem, field);
        expectedValue = value;
        return { default: skip(), rules: [leaf.then(assign(triagePipeline))] };
      });

      const output = generateDefaultPipelineAssignmentFileContent(
        contract,
        definitionIdToKey,
      );

      expect(output).toContain(
        `workItem.${field}.eq(${JSON.stringify(expectedValue)})`,
      );
    }
  });

  test("still reconstructs workItem.field(name) for the fields bag, unaffected by top-level support", () => {
    const contract = contractFromSpec(({ workItem, assign, skip }) => ({
      default: skip(),
      rules: [
        workItem
          .field("What are the Company Name(s):")
          .eq("Acme")
          .then(assign(triagePipeline)),
      ],
    }));

    const output = generateDefaultPipelineAssignmentFileContent(
      contract,
      definitionIdToKey,
    );

    expect(output).toContain('workItem.field("What are the Company Name(s):").eq("Acme")');
  });

  test("a hand-authored path outside the known fact/path vocabulary still throws UnsupportedRuleError", () => {
    const contract: DefaultPipelineAssignmentContract = {
      pipelineDefinitionId: PIPELINE_DEFINITION_ID,
      rulesJson: {
        rules: [
          {
            conditions: {
              all: [
                {
                  fact: "workItem",
                  path: "$.fields.status.nested",
                  operator: "equal",
                  value: "x",
                },
              ],
            },
            event: { type: "assign" },
          },
        ],
      },
      defaultEventType: "skip",
      defaultEventParamsJson: null,
      allowedEventTypes: ["assign", "skip"],
    };

    expect(() =>
      generateDefaultPipelineAssignmentFileContent(contract, definitionIdToKey),
    ).toThrow(UnsupportedRuleError);
  });

  test("import statement never leaks ctx-only names (workItem/context/assign/skip/all/any)", () => {
    const contract = contractFromSpec(({ workItem, context, any, assign, skip }) => ({
      default: skip(),
      rules: [
        any(
          workItem.platform.eq("github"),
          context.isNew.eq(true),
        ).then(assign(triagePipeline)),
      ],
    }));

    const output = generateDefaultPipelineAssignmentFileContent(
      contract,
      definitionIdToKey,
    );
    const importLine = output.split("\n")[0];

    expect(importLine).toBe(
      'import { defaultPipelineAssignment } from "@boboddy/sdk/definitions/pipelines";',
    );
    expect(output).toContain(
      "export default defaultPipelineAssignment(({ any, assign, context, skip, workItem }) => ({",
    );
  });
});
