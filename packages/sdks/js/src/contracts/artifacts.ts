/**
 * Artifact contract shared by the SDK, the opencode plugin, the worker and
 * core. Everything here works on JSON Schema only (the `x-boboddy-artifact`
 * keyword), never on Zod schemas, so the server can use it without knowing
 * how a step was authored.
 */
import { z } from "zod";

export const artifactKindSchema = z.enum([
  "generic",
  "playwright-trace",
  "video",
  "image",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const ARTIFACT_SCHEMA_KEYWORD = "x-boboddy-artifact";

export type ArtifactSchemaKeyword = {
  readonly accept: readonly string[];
};

/** A JSON Schema node. `true` / `false` are the boolean schema forms. */
export type ArtifactJsonSchemaNode =
  boolean | { readonly [key: string]: unknown };

/** A declared artifact field in a step's result schema. */
export type ArtifactField = {
  /**
   * Dot path of the field. Array items appear as `[]`, e.g. `shots[]` or
   * `runs[].video`.
   */
  readonly path: string;
  /** Lower-case extensions with a leading dot. Empty accepts any file. */
  readonly accept: readonly string[];
  readonly nullable: boolean;
  readonly description: string | null;
  /** True when the field sits inside an array, which v1 does not support. */
  readonly inArray: boolean;
};

export const artifactPlatforms = ["github", "jira", "bitbucket"] as const;
export type ArtifactPlatform = (typeof artifactPlatforms)[number];

/**
 * Extensions each platform can show inline in a comment. Anything else is
 * linked to its Boboddy artifact page. GitHub and Bitbucket link everything
 * in v1.
 */
export const EMBEDDABLE_ARTIFACT_EXTENSIONS: Readonly<
  Record<ArtifactPlatform, readonly string[]>
> = {
  jira: [".png", ".gif", ".mp4", ".webm"],
  github: [],
  bitbucket: [],
};

export function isEmbeddableArtifactExtension(
  platform: ArtifactPlatform,
  extension: string,
): boolean {
  return EMBEDDABLE_ARTIFACT_EXTENSIONS[platform].includes(
    extension.toLowerCase(),
  );
}

/** The lower-cased extension of a file name, with its dot; `""` when none. */
export function artifactFileExtension(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** Whether a file name matches an `accept` list. An empty list accepts any file. */
export function artifactAcceptsFile(
  accept: readonly string[],
  fileName: string,
): boolean {
  if (accept.length === 0) return true;
  return accept.includes(artifactFileExtension(fileName));
}

function asRecord(
  node: ArtifactJsonSchemaNode | undefined,
): { readonly [key: string]: unknown } | null {
  return typeof node === "object" ? node : null;
}

function isNullSchema(node: ArtifactJsonSchemaNode): boolean {
  return asRecord(node)?.["type"] === "null";
}

function schemaBranches(
  record: { readonly [key: string]: unknown },
  keyword: "anyOf" | "oneOf" | "allOf",
): ArtifactJsonSchemaNode[] {
  const value = record[keyword];
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(
    (entry): entry is ArtifactJsonSchemaNode =>
      typeof entry === "boolean" ||
      (typeof entry === "object" && entry !== null && !Array.isArray(entry)),
  );
}

/** Reads the `x-boboddy-artifact` keyword on this exact node. */
export function readArtifactKeyword(
  node: ArtifactJsonSchemaNode,
): ArtifactSchemaKeyword | null {
  const record = asRecord(node);
  const keyword = asRecord(
    record?.[ARTIFACT_SCHEMA_KEYWORD] as ArtifactJsonSchemaNode | undefined,
  );
  if (!keyword) return null;
  const accept = keyword["accept"];
  return {
    accept: Array.isArray(accept)
      ? (accept as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  };
}

export type ArtifactNodeMatch = ArtifactSchemaKeyword & {
  readonly nullable: boolean;
  readonly description: string | null;
};

function readDescription(node: ArtifactJsonSchemaNode): string | null {
  const description = asRecord(node)?.["description"];
  return typeof description === "string" ? description : null;
}

/**
 * Matches a node that is an artifact field, either directly or as
 * `anyOf: [<artifact>, { type: "null" }]` (Zod's `.nullable()`).
 */
export function matchArtifactNode(
  node: ArtifactJsonSchemaNode,
): ArtifactNodeMatch | null {
  const direct = readArtifactKeyword(node);
  if (direct) {
    const types = asRecord(node)?.["type"];
    return {
      ...direct,
      nullable: Array.isArray(types) && types.includes("null"),
      description: readDescription(node),
    };
  }

  const record = asRecord(node);
  if (!record) return null;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schemaBranches(record, keyword);
    const nonNull = branches.filter((branch) => !isNullSchema(branch));
    const [only] = nonNull;
    if (!only || nonNull.length !== 1 || branches.length !== 2) continue;
    const inner = readArtifactKeyword(only);
    if (!inner) continue;
    return {
      ...inner,
      nullable: true,
      description: readDescription(node) ?? readDescription(only),
    };
  }
  return null;
}

const MAX_REF_HOPS = 16;

function resolveLocalRef(
  root: ArtifactJsonSchemaNode,
  ref: string,
): ArtifactJsonSchemaNode | null {
  if (!ref.startsWith("#")) return null;
  const pointer = ref.slice(1);
  if (pointer === "" || pointer === "/") return root;
  let current: unknown = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[token];
  }
  return typeof current === "object" && current !== null
    ? (current as ArtifactJsonSchemaNode)
    : null;
}

/**
 * Every artifact field declared in a result schema: walks object
 * properties, `anyOf` / `oneOf` / `allOf` branches, local `$ref`s and array
 * items. Fields inside arrays are returned with `inArray: true`; v1 rejects
 * them at definition time.
 */
export function findArtifactFields(
  schema: ArtifactJsonSchemaNode | null | undefined,
): ArtifactField[] {
  if (schema === null || schema === undefined) return [];
  const root = schema;
  const fields = new Map<string, ArtifactField>();

  const visit = (
    node: ArtifactJsonSchemaNode,
    path: string,
    inArray: boolean,
    hops: number,
  ): void => {
    if (hops > MAX_REF_HOPS) return;
    const record = asRecord(node);
    if (!record) return;

    const ref = record["$ref"];
    if (typeof ref === "string") {
      const target = resolveLocalRef(root, ref);
      if (target) visit(target, path, inArray, hops + 1);
      return;
    }

    const match = path ? matchArtifactNode(node) : null;
    if (match) {
      if (!fields.has(path)) {
        fields.set(path, {
          path,
          accept: match.accept,
          nullable: match.nullable,
          description: match.description,
          inArray,
        });
      }
      return;
    }

    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      for (const branch of schemaBranches(record, keyword)) {
        visit(branch, path, inArray, hops + 1);
      }
    }

    const properties = asRecord(
      record["properties"] as ArtifactJsonSchemaNode | undefined,
    );
    for (const [key, child] of Object.entries(properties ?? {})) {
      const childNode = child as ArtifactJsonSchemaNode;
      visit(childNode, path ? `${path}.${key}` : key, inArray, hops);
    }

    const items = record["items"] as ArtifactJsonSchemaNode | undefined;
    if (items !== undefined) visit(items, `${path}[]`, true, hops);
    const prefixItems = record["prefixItems"];
    if (Array.isArray(prefixItems)) {
      for (const item of prefixItems as ArtifactJsonSchemaNode[]) {
        visit(item, `${path}[]`, true, hops);
      }
    }
  };

  visit(schema, "", false, 0);
  return [...fields.values()];
}
