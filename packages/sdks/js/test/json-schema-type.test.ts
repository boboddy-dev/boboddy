import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  resolvePathType,
  resolveSchemaType,
} from "../src/definitions/validation";
import type { JsonSchemaNode } from "../src/definitions/validation";

describe("resolveSchemaType", () => {
  test("resolves every primitive type", () => {
    expect(resolveSchemaType(z.toJSONSchema(z.string()))).toBe("string");
    expect(resolveSchemaType(z.toJSONSchema(z.number()))).toBe("number");
    expect(resolveSchemaType(z.toJSONSchema(z.boolean()))).toBe("boolean");
    expect(resolveSchemaType(z.toJSONSchema(z.null()))).toBe("null");
    expect(resolveSchemaType(z.toJSONSchema(z.object({ a: z.string() })))).toBe(
      "object",
    );
    expect(resolveSchemaType(z.toJSONSchema(z.array(z.string())))).toBe(
      "array",
    );
  });

  test("collapses the `integer` refinement into `number`", () => {
    expect(resolveSchemaType(z.toJSONSchema(z.number().int()))).toBe(
      "number",
    );
  });

  test("is `unknown` for a schema too loose to prove a type", () => {
    // `z.unknown()` serializes to `{}` — no `type` keyword at all.
    expect(resolveSchemaType(z.toJSONSchema(z.unknown()))).toBe("unknown");
  });

  test("is `unknown` for an absent schema", () => {
    expect(resolveSchemaType({})).toBe("unknown");
  });

  test("is `unknown` for a boolean schema", () => {
    expect(resolveSchemaType(true)).toBe("unknown");
    expect(resolveSchemaType(false)).toBe("unknown");
  });

  test("is `unknown` for an `anyOf` whose branches disagree on type", () => {
    const schema = z.toJSONSchema(
      z.union([z.object({ a: z.string() }), z.number()]),
    );
    expect(resolveSchemaType(schema)).toBe("unknown");
  });

  test("resolves a shared type across `anyOf` branches that agree", () => {
    const schema = z.toJSONSchema(
      z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    );
    expect(resolveSchemaType(schema)).toBe("object");
  });

  test("is `unknown` for an unresolvable `$ref`", () => {
    const schema: JsonSchemaNode = { $ref: "#/$defs/Missing" };
    expect(resolveSchemaType(schema)).toBe("unknown");
  });

  test("follows a `$ref` that does resolve, against the document root", () => {
    const root: JsonSchemaNode = {
      $defs: { Count: { type: "number" } },
      $ref: "#/$defs/Count",
    };
    expect(resolveSchemaType(root, root)).toBe("number");
  });
});

describe("resolvePathType", () => {
  const RESULT = z.toJSONSchema(
    z.object({
      findings: z.string(),
      nested: z.object({ deep: z.number() }),
      items: z.array(z.object({ label: z.string() })),
      loose: z.unknown(),
      union: z.union([z.object({ a: z.string() }), z.number()]),
    }),
  );

  test("resolves the type of a top-level primitive property", () => {
    expect(resolvePathType(RESULT, "findings")).toBe("string");
  });

  test("resolves the type at the end of a nested object path", () => {
    expect(resolvePathType(RESULT, "nested.deep")).toBe("number");
  });

  test("resolves the array type, and the type of its element", () => {
    expect(resolvePathType(RESULT, "items")).toBe("array");
    expect(resolvePathType(RESULT, "items[0]")).toBe("object");
    expect(resolvePathType(RESULT, "items[0].label")).toBe("string");
  });

  test("resolves the whole root with `$` or an empty path", () => {
    expect(resolvePathType(RESULT, "$")).toBe("object");
    expect(resolvePathType(RESULT, "")).toBe("object");
  });

  test("is `unknown` when the resolved node is an `anyOf` that disagrees on type", () => {
    expect(resolvePathType(RESULT, "union")).toBe("unknown");
  });

  test("is `unknown` when the path runs through a loose/unknown property", () => {
    expect(resolvePathType(RESULT, "loose.whatever")).toBe("unknown");
  });

  test("is `unknown` for an absent schema", () => {
    expect(resolvePathType({}, "anything.at.all")).toBe("unknown");
  });

  test("is `unknown` when the path itself does not resolve", () => {
    expect(resolvePathType(RESULT, "totally.not.real")).toBe("unknown");
  });
});
