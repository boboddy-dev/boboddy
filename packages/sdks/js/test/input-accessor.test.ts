import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createInputAccessor,
  isInputAccessor,
  materializeAccessor,
} from "../src/definitions/pipelines/input-accessor";

const schema = z.object({
  title: z.string(),
  metadata: z.object({
    priority: z.number(),
    nested: z.object({ leaf: z.string() }),
  }),
  labels: z.array(z.string()),
});

describe("input accessor", () => {
  test.concurrent("createInputAccessor returns a detectable accessor", () => {
    const input = createInputAccessor(schema);
    expect(isInputAccessor(input)).toBe(true);
  });

  test.concurrent("drilling produces sub-accessors", () => {
    const input = createInputAccessor(schema);
    expect(isInputAccessor(input.title)).toBe(true);
    expect(isInputAccessor(input.metadata)).toBe(true);
    expect(isInputAccessor(input.metadata.nested)).toBe(true);
    expect(isInputAccessor(input.metadata.nested.leaf)).toBe(true);
  });

  test.concurrent("isInputAccessor returns false for plain objects and primitives", () => {
    expect(isInputAccessor({ source: "pipeline_input", path: "x" })).toBe(false);
    expect(isInputAccessor(null)).toBe(false);
    expect(isInputAccessor(undefined)).toBe(false);
    expect(isInputAccessor("title")).toBe(false);
    expect(isInputAccessor(42)).toBe(false);
  });

  test.concurrent("materializeAccessor produces a binding at the root path", () => {
    const input = createInputAccessor(schema);
    expect(materializeAccessor(input)).toEqual({
      source: "pipeline_input",
      path: "",
    });
  });

  test.concurrent("materializeAccessor produces dotted paths for nested drills", () => {
    const input = createInputAccessor(schema);
    expect(materializeAccessor(input.title)).toEqual({
      source: "pipeline_input",
      path: "title",
    });
    expect(materializeAccessor(input.metadata.priority)).toEqual({
      source: "pipeline_input",
      path: "metadata.priority",
    });
    expect(materializeAccessor(input.metadata.nested.leaf)).toEqual({
      source: "pipeline_input",
      path: "metadata.nested.leaf",
    });
  });

  test.concurrent("array index drilling appends numeric path segments", () => {
    const input = createInputAccessor(schema);
    expect(materializeAccessor(input.labels[0]!)).toEqual({
      source: "pipeline_input",
      path: "labels.0",
    });
  });

  test.concurrent("JSON.stringify emits the binding shape", () => {
    const input = createInputAccessor(schema);
    expect(JSON.parse(JSON.stringify(input.metadata.priority))).toEqual({
      source: "pipeline_input",
      path: "metadata.priority",
    });
  });

  test.concurrent("primitive coercion throws a clear error", () => {
    const input = createInputAccessor(schema);
    expect(() => `${input.title}`).toThrow(/cannot be coerced to a primitive/);
    expect(() => Number(input.metadata.priority)).toThrow(
      /cannot be coerced to a primitive/,
    );
  });

  test.concurrent("spread throws a clear error", () => {
    const input = createInputAccessor(schema);
    expect(() => ({ ...input.metadata })).toThrow(/cannot be enumerated/);
    expect(() => Object.keys(input)).toThrow(/cannot be enumerated/);
  });

  test.concurrent("unknown symbol keys return undefined (no spurious drilling)", () => {
    const input = createInputAccessor(schema);
    const accessor = input.title as unknown as Record<symbol, unknown>;
    expect(accessor[Symbol.iterator]).toBeUndefined();
    expect(accessor[Symbol.toStringTag]).toBeUndefined();
  });

  test.concurrent("assignment throws", () => {
    const input = createInputAccessor(schema);
    expect(() => {
      (input as unknown as { title: string }).title = "x";
    }).toThrow(/read-only/);
  });
});
