import type { ZodType } from "zod";
import { matchArtifactNode } from "../../contracts/artifacts";
import { resolveSourcePathNode } from "../validation/json-schema-paths";

export type SignalTypeStr =
  "string" | "number" | "boolean" | "object" | "array" | "artifact";

/**
 * Resolves the Zod schema node at a dot-notation path within a ZodObject schema.
 * Returns undefined if the path does not exist.
 */
function resolveZodSchemaAtPath(
  schema: ZodType | undefined,
  path: string,
): ZodType | undefined {
  if (!schema) return undefined;
  const segments = path.split(".");
  let current: ZodType | undefined = schema;
  for (const segment of segments) {
    if (!current) return undefined;
    // Unwrap wrapper types (optional, nullable, default, catch, etc.)
    current = unwrapZodWrappers(current);
    const def = (
      current as unknown as {
        def?: { type?: string; shape?: Record<string, ZodType> };
      }
    ).def;
    if (!def || def.type !== "object" || !def.shape) return undefined;
    current = def.shape[segment];
  }
  return current;
}

/**
 * Unwraps Zod wrapper types (optional, nullable, default, catch) to reach the
 * inner type, then maps the resulting Zod type name to a SignalTypeStr.
 */
function zodTypeToSignalType(
  schema: ZodType | undefined,
): SignalTypeStr | undefined {
  if (!schema) return undefined;
  const unwrapped = unwrapZodWrappers(schema);
  const def = (unwrapped as unknown as { def?: { type?: string } }).def;
  const typeName = def?.type;
  switch (typeName) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return undefined;
  }
}

/**
 * The signal type for `sourcePath`: `"artifact"` when the result schema marks
 * the field with `x-boboddy-artifact` (directly or nullable), otherwise the
 * Zod type at that path.
 */
export function inferSignalType(
  result: ZodType | undefined,
  resultSchemaJson: Record<string, unknown> | null,
  sourcePath: string,
): SignalTypeStr | undefined {
  const node = resultSchemaJson
    ? resolveSourcePathNode(resultSchemaJson, sourcePath)
    : null;
  if (node !== null && matchArtifactNode(node)) return "artifact";
  return zodTypeToSignalType(resolveZodSchemaAtPath(result, sourcePath));
}

/** Recursively unwraps optional / nullable / default / catch wrappers. */
function unwrapZodWrappers(schema: ZodType): ZodType {
  const def = (
    schema as unknown as { def?: { type?: string; innerType?: ZodType } }
  ).def;
  if (!def) return schema;
  if (
    def.type === "optional" ||
    def.type === "nullable" ||
    def.type === "default" ||
    def.type === "catch"
  ) {
    if (def.innerType) return unwrapZodWrappers(def.innerType);
  }
  return schema;
}
