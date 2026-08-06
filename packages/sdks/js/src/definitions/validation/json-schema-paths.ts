// Deciding whether a signal `sourcePath` can ever resolve against a step's
// `resultSchemaJson`.
//
// `resultSchemaJson` is JSON Schema produced by Zod's `toJSONSchema`, and the
// path grammar is the one the runtime extractor uses (see
// `packages/core/.../extract-step-execution-signals.ts`): an optional `$` /
// `$.` root prefix, `.` between object keys, and `[n]` or a bare numeric
// segment to index an array.
//
// The bias is deliberate and one-directional: a path is only ever reported
// invalid when the schema PROVES it can never resolve. Anything the schema
// leaves open — a loose object, a record, an unresolvable `$ref`, a step with
// no result schema at all — comes back `indeterminate` and is allowed through.
// A false rejection at push time is worse than a missed dead signal.

/** A JSON Schema node. `true` / `false` are the boolean schema forms. */
export type JsonSchemaNode = boolean | { readonly [key: string]: unknown };

export type PathFailureReason =
  /** The parent is a closed object with no such property. */
  | "unknown-property"
  /** The parent is an array and the segment is not a numeric index. */
  | "not-an-array-index"
  /** The parent is a scalar, so it has no members at all. */
  | "scalar-has-no-members";

export type PathResolution =
  /** The whole path resolves to a node in the schema. */
  | { readonly kind: "resolved" }
  /** Neither provably valid nor provably invalid — the schema is too loose. */
  | { readonly kind: "indeterminate" }
  | {
      readonly kind: "invalid";
      /** Dot path of the prefix that did resolve; `""` at the root. */
      readonly resolvedPrefix: string;
      /** The first segment that could not resolve. */
      readonly segment: string;
      readonly reason: PathFailureReason;
      /** Paths that DO resolve below `resolvedPrefix`, relative to it. */
      readonly availablePaths: readonly string[];
    };

const SEGMENT_PATTERN = /([^.[\]]+)|(\[(\d+)\])/g;
const NUMERIC_SEGMENT = /^\d+$/;
const SCALAR_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const MAX_REF_HOPS = 16;
const MAX_CANDIDATES = 64;

/** Splits a `sourcePath` exactly as the runtime signal extractor does. */
export function parseSourcePath(sourcePath: string): string[] {
  const trimmed = sourcePath.trim();
  const normalized =
    trimmed === "$"
      ? ""
      : trimmed.startsWith("$.")
        ? trimmed.slice(2)
        : trimmed;
  if (!normalized) return [];
  return [...normalized.matchAll(SEGMENT_PATTERN)]
    .map((match) => match[1] ?? match[3])
    .filter((segment): segment is string => Boolean(segment));
}

// Every entry point here reads raw JSON, so `unknown` is the honest input type
// and this is the narrowing boundary the rule asks for.
// eslint-disable-next-line local/no-unknown-parameter-type
function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return (
    typeof value === "boolean" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  );
}

function asRecord(
  node: JsonSchemaNode,
): { readonly [key: string]: unknown } | null {
  return typeof node === "boolean" ? null : node;
}

/** Resolves a local `#/...` JSON pointer against the schema document root. */
function resolveRef(root: JsonSchemaNode, ref: string): JsonSchemaNode | null {
  if (!ref.startsWith("#")) return null;
  const pointer = ref.slice(1);
  if (pointer === "" || pointer === "/") return root;
  if (!pointer.startsWith("/")) return null;

  let current: unknown = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[token];
  }
  return isSchemaNode(current) ? current : null;
}

/**
 * Flattens one node into the concrete nodes a value at that position could
 * satisfy: follows `$ref`, and splits `anyOf` / `oneOf` / `allOf` into
 * branches. Returns `null` when a `$ref` cannot be resolved, which the caller
 * treats as `indeterminate`.
 *
 * `allOf` is flattened into branches rather than intersected. That is looser
 * than the spec (a value must satisfy every `allOf` branch, not just one), and
 * looser is the safe direction here: a property declared in any branch counts
 * as reachable.
 */
function flatten(
  node: JsonSchemaNode,
  root: JsonSchemaNode,
): JsonSchemaNode[] | null {
  const out: JsonSchemaNode[] = [];
  const queue: Array<{ node: JsonSchemaNode; hops: number }> = [
    { node, hops: 0 },
  ];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    if (out.length >= MAX_CANDIDATES) return null;
    if (entry.hops > MAX_REF_HOPS) return null;

    const record = asRecord(entry.node);
    if (!record) {
      out.push(entry.node);
      continue;
    }

    const ref = record["$ref"];
    if (typeof ref === "string") {
      const target = resolveRef(root, ref);
      if (!target) return null;
      queue.push({ node: target, hops: entry.hops + 1 });
      continue;
    }

    const branches = ["anyOf", "oneOf", "allOf"].flatMap((keyword) => {
      const value = record[keyword];
      return Array.isArray(value) ? value.filter(isSchemaNode) : [];
    });
    if (branches.length > 0) {
      for (const branch of branches) {
        queue.push({ node: branch, hops: entry.hops + 1 });
      }
      continue;
    }

    out.push(entry.node);
  }

  return out;
}

function typeNames(record: { readonly [key: string]: unknown }): Set<string> {
  const raw = record["type"];
  if (typeof raw === "string") return new Set([raw]);
  if (Array.isArray(raw)) {
    return new Set(
      raw.filter((entry): entry is string => typeof entry === "string"),
    );
  }
  return new Set();
}

type SegmentOutcome =
  | { readonly kind: "child"; readonly node: JsonSchemaNode }
  | { readonly kind: "indeterminate" }
  | {
      readonly kind: "invalid";
      readonly reason: PathFailureReason;
      readonly availablePaths: readonly string[];
    };

const INDETERMINATE: SegmentOutcome = { kind: "indeterminate" };

function stepIntoObject(
  record: { readonly [key: string]: unknown },
  segment: string,
): SegmentOutcome {
  const properties = asRecord(
    isSchemaNode(record["properties"]) ? record["properties"] : {},
  );
  const declared = properties ?? {};

  const child = declared[segment];
  if (isSchemaNode(child)) return { kind: "child", node: child };

  // A pattern could match anything, so nothing is provable.
  if (record["patternProperties"] !== undefined) return INDETERMINATE;

  // `additionalProperties: false` is what Zod emits for a normal `z.object`,
  // and it is the only thing that makes an absent property provably dead.
  // Absent (JSON Schema's permissive default), `{}`, or a subschema all mean
  // extra keys are legal, so we cannot prove anything.
  if (record["additionalProperties"] !== false) return INDETERMINATE;

  return {
    kind: "invalid",
    reason: "unknown-property",
    availablePaths: Object.keys(declared).sort(),
  };
}

function stepIntoArray(
  record: { readonly [key: string]: unknown },
  segment: string,
): SegmentOutcome {
  if (!NUMERIC_SEGMENT.test(segment)) {
    // The runtime does `array[Number(segment)]`, so a non-numeric segment is
    // `array[NaN]` — always `undefined`.
    return {
      kind: "invalid",
      reason: "not-an-array-index",
      availablePaths: [],
    };
  }

  const prefixItems: unknown = record["prefixItems"];
  if (Array.isArray(prefixItems)) {
    const positional: unknown = (prefixItems as readonly unknown[])[
      Number(segment)
    ];
    if (isSchemaNode(positional)) return { kind: "child", node: positional };
  }
  const items = record["items"];
  if (isSchemaNode(items)) return { kind: "child", node: items };
  return INDETERMINATE;
}

function stepInto(node: JsonSchemaNode, segment: string): SegmentOutcome {
  const record = asRecord(node);
  // `true` / `false` schemas and `{}` (Zod's `z.unknown()`) say nothing.
  if (!record || Object.keys(record).length === 0) return INDETERMINATE;

  const types = typeNames(record);
  const objectLike =
    types.has("object") ||
    record["properties"] !== undefined ||
    record["patternProperties"] !== undefined ||
    record["additionalProperties"] !== undefined;
  const arrayLike =
    types.has("array") ||
    record["items"] !== undefined ||
    record["prefixItems"] !== undefined;

  const outcomes: SegmentOutcome[] = [];
  if (objectLike) outcomes.push(stepIntoObject(record, segment));
  if (arrayLike) outcomes.push(stepIntoArray(record, segment));

  if (outcomes.length === 0) {
    if (types.size > 0 && [...types].every((name) => SCALAR_TYPES.has(name))) {
      return {
        kind: "invalid",
        reason: "scalar-has-no-members",
        availablePaths: [],
      };
    }
    return INDETERMINATE;
  }

  return combine(outcomes);
}

/** `child` beats `indeterminate` beats `invalid`. */
function combine(outcomes: readonly SegmentOutcome[]): SegmentOutcome {
  const children = outcomes.filter(
    (outcome): outcome is Extract<SegmentOutcome, { kind: "child" }> =>
      outcome.kind === "child",
  );
  if (children.length > 0) return children[0] ?? INDETERMINATE;
  if (outcomes.some((outcome) => outcome.kind === "indeterminate")) {
    return INDETERMINATE;
  }

  const invalid = outcomes.filter(
    (outcome): outcome is Extract<SegmentOutcome, { kind: "invalid" }> =>
      outcome.kind === "invalid",
  );
  const first = invalid[0];
  if (!first) return INDETERMINATE;
  return {
    kind: "invalid",
    reason: first.reason,
    availablePaths: [
      ...new Set(invalid.flatMap((outcome) => outcome.availablePaths)),
    ].sort(),
  };
}

/**
 * Enumerates dot paths that resolve below `node`, for error messages.
 *
 * Depth-limited and count-limited: this is a hint for a human reading a push
 * failure, not an exhaustive schema dump. Arrays are treated as leaves.
 */
export function enumeratePaths(
  node: JsonSchemaNode,
  root: JsonSchemaNode,
  maxDepth = 3,
  limit = 40,
): string[] {
  const out: string[] = [];

  const visit = (
    current: JsonSchemaNode,
    prefix: string,
    depth: number,
  ): void => {
    if (out.length >= limit || depth > maxDepth) return;
    for (const branch of flatten(current, root) ?? []) {
      const record = asRecord(branch);
      const properties = record
        ? asRecord(
            isSchemaNode(record["properties"]) ? record["properties"] : {},
          )
        : null;
      if (!properties) continue;
      for (const [key, child] of Object.entries(properties)) {
        if (out.length >= limit) return;
        const path = prefix ? `${prefix}.${key}` : key;
        out.push(path);
        if (isSchemaNode(child)) visit(child, path, depth + 1);
      }
    }
  };

  visit(node, "", 1);
  return [...new Set(out)].sort();
}

/**
 * Whether `sourcePath` can resolve against `schema`.
 *
 * Pass the step's `resultSchemaJson` as both the node and the document root;
 * `$ref`s are resolved against the root.
 */
export function resolveSourcePath(
  schema: JsonSchemaNode,
  sourcePath: string,
): PathResolution {
  const segments = parseSourcePath(sourcePath);
  // `"$"` (or an empty path) is the whole result object and always resolves.
  if (segments.length === 0) return { kind: "resolved" };

  let candidates: JsonSchemaNode[] = [schema];
  let resolvedPrefix = "";

  for (const segment of segments) {
    const expanded = candidates.flatMap((node) => flatten(node, schema) ?? []);
    if (expanded.length === 0) return { kind: "indeterminate" };

    const outcome = combine(expanded.map((node) => stepInto(node, segment)));
    if (outcome.kind === "indeterminate") return { kind: "indeterminate" };
    if (outcome.kind === "invalid") {
      // Everything reachable below the parent, so the message can offer the
      // caller the paths that would have worked instead.
      const availablePaths = [
        ...new Set(expanded.flatMap((node) => enumeratePaths(node, schema))),
      ].sort();
      return {
        kind: "invalid",
        resolvedPrefix,
        segment,
        reason: outcome.reason,
        availablePaths,
      };
    }

    candidates = [outcome.node];
    resolvedPrefix = resolvedPrefix ? `${resolvedPrefix}.${segment}` : segment;
  }

  return { kind: "resolved" };
}
