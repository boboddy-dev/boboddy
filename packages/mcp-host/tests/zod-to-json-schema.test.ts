import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodShapeToJsonSchema } from "../src/zod-to-json-schema";

describe("zodShapeToJsonSchema", () => {
  test("string field becomes { type: 'string' }", () => {
    const schema = zodShapeToJsonSchema({ name: z.string() });
    expect(schema.properties["name"]).toMatchObject({ type: "string" });
    expect(schema.required).toContain("name");
  });

  test("optional string is not in required[]", () => {
    const schema = zodShapeToJsonSchema({ name: z.string().optional() });
    expect(schema.required ?? []).not.toContain("name");
  });

  test("number field becomes { type: 'number' }", () => {
    const schema = zodShapeToJsonSchema({ count: z.number() });
    expect(schema.properties["count"]).toMatchObject({ type: "number" });
  });

  test("boolean field becomes { type: 'boolean' }", () => {
    const schema = zodShapeToJsonSchema({ flag: z.boolean() });
    expect(schema.properties["flag"]).toMatchObject({ type: "boolean" });
  });

  test("enum field becomes { type: 'string', enum: [...] }", () => {
    const schema = zodShapeToJsonSchema({
      color: z.enum(["red", "green", "blue"]),
    });
    expect(schema.properties["color"]).toMatchObject({
      type: "string",
      enum: ["red", "green", "blue"],
    });
  });

  test("array field becomes { type: 'array', items: {...} }", () => {
    const schema = zodShapeToJsonSchema({ tags: z.array(z.string()) });
    expect(schema.properties["tags"]).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
  });

  test("nested object field", () => {
    const schema = zodShapeToJsonSchema({
      config: z.object({ key: z.string() }),
    });
    expect(schema.properties["config"]).toMatchObject({
      type: "object",
      properties: { key: { type: "string" } },
    });
  });

  test("default field has a 'default' property in its schema", () => {
    // Zod v4's z.toJSONSchema() includes the default value in the property schema.
    // Default-bearing fields are still listed in required[] — this is valid JSON Schema
    // (the default is applied by the parser, not the validator).
    const schema = zodShapeToJsonSchema({
      verbose: z.boolean().default(false),
    });
    const verboseProp = schema.properties["verbose"] as Record<string, unknown>;
    expect(verboseProp["default"]).toBe(false);
  });

  test("optional field is excluded from required[]", () => {
    const schema = zodShapeToJsonSchema({
      a: z.string(),
      b: z.number(),
      c: z.boolean().optional(),
    });
    expect(schema.required).toContain("a");
    expect(schema.required).toContain("b");
    expect(schema.required ?? []).not.toContain("c");
  });

  test("empty shape produces empty properties", () => {
    const schema = zodShapeToJsonSchema({});
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({});
    expect(schema.required ?? []).toHaveLength(0);
  });
});
