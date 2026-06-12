import { z, type ZodTypeAny } from "zod";
import type { DiscoveredTool } from "./types";

type JsonSchema = DiscoveredTool["inputSchema"];

type ZodRawShape = Record<string, ZodTypeAny>;

/**
 * Converts a Zod object shape (as used in tool({ args: {...} })) into a JSON Schema object
 * suitable for the MCP tools/list inputSchema field.
 *
 * Uses Zod v4's built-in z.toJSONSchema() rather than a hand-rolled traversal.
 */
export function zodShapeToJsonSchema(shape: ZodRawShape): JsonSchema {
  const schema = z.object(shape);
  // z.toJSONSchema returns a full JSON Schema document; we want just the object schema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const full = z.toJSONSchema(schema) as Record<string, any>;

  return {
    type: "object",
    properties: (full["properties"] as Record<string, unknown>) ?? {},
    ...(Array.isArray(full["required"]) ? { required: full["required"] as string[] } : {}),
    additionalProperties: false,
  };
}
