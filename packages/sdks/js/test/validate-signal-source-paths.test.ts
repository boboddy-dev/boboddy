import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { sourcePathIssues, stepSpec } from "./definition-spec-fixtures";

describe("validateDefinitionSpecs — signal sourcePath resolution", () => {
  const RESULT = z.object({
    findings: z.string(),
    nested: z.object({ deep: z.number() }),
    items: z.array(z.object({ label: z.string() })),
  });

  test("accepts every path that exists, including nested and indexed", () => {
    expect(
      sourcePathIssues(RESULT, [
        "findings",
        "nested",
        "nested.deep",
        "items",
        "items[0]",
        "items[0].label",
        "items.0.label",
        "$",
        "$.nested.deep",
      ]),
    ).toEqual([]);
  });

  test("rejects a path whose first segment does not exist", () => {
    const issues = sourcePathIssues(RESULT, ["totally.not.real"]);
    expect(issues).toHaveLength(1);
    const message = issues[0] ?? "";
    expect(message).toContain('Step "s"');
    expect(message).toContain('sourcePath "totally.not.real"');
    expect(message).toContain('the result root has no property "totally"');
    // Actionable: the paths that would have worked.
    expect(message).toContain("findings");
    expect(message).toContain("nested.deep");
  });

  test("rejects a path whose nested segment does not exist, scoped to the parent", () => {
    const issues = sourcePathIssues(RESULT, ["nested.nope"]);
    expect(issues).toHaveLength(1);
    const message = issues[0] ?? "";
    expect(message).toContain('"nested" has no property "nope"');
    expect(message).toContain('Valid sourcePaths under "nested": deep.');
  });

  test("rejects a member of a scalar", () => {
    expect(sourcePathIssues(RESULT, ["findings.length"])[0]).toContain(
      '"findings" is a scalar, so it has no property "length"',
    );
  });

  test("rejects a non-numeric segment on an array", () => {
    expect(sourcePathIssues(RESULT, ["items.label"])[0]).toContain(
      '"items" is an array, so "label" can never index it',
    );
  });

  test("allows anything when the step declares no result schema", () => {
    expect(sourcePathIssues(null, ["anything.at.all"])).toEqual([]);
  });

  test("allows anything under a loose object", () => {
    expect(
      sourcePathIssues(z.object({ a: z.string() }).loose(), ["b.c"]),
    ).toEqual([]);
  });

  test("allows anything under a record", () => {
    expect(
      sourcePathIssues(z.object({ r: z.record(z.string(), z.unknown()) }), [
        "r.whatever",
      ]),
    ).toEqual([]);
  });

  test("allows anything under z.unknown()", () => {
    expect(
      sourcePathIssues(z.object({ u: z.unknown() }), ["u.deep.deeper"]),
    ).toEqual([]);
  });

  test("accepts a path valid in only one union branch", () => {
    const union = z.object({
      u: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    });
    expect(sourcePathIssues(union, ["u.a", "u.b"])).toEqual([]);
    expect(sourcePathIssues(union, ["u.c"])).toHaveLength(1);
  });

  test("looks through nullable wrappers", () => {
    const schema = z.object({ n: z.object({ x: z.string() }).nullable() });
    expect(sourcePathIssues(schema, ["n.x"])).toEqual([]);
    expect(sourcePathIssues(schema, ["n.y"])).toHaveLength(1);
  });

  test("allows a path behind an unresolvable $ref", () => {
    const step = stepSpec("s", null, []);
    const withRef: StepDefinitionSpec = {
      ...step,
      resultSchemaJson: {
        type: "object",
        properties: { a: { $ref: "#/$defs/Missing" } },
        additionalProperties: false,
      },
      signalExtractorDefinitions: [
        {
          key: "a",
          sourcePath: "a.whatever",
          type: "string",
          required: true,
          availableWhenResultStatusIn: null,
        },
      ],
    };
    expect(
      validateDefinitionSpecs({ pipelines: [], steps: [withRef] }),
    ).toEqual([]);
  });
});
