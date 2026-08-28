import type { GetApiWorkItemsByWorkItemIdResponses } from "../../generated/types.gen";

// ─── Work-item top-level fields ───────────────────────────────────────────────

/**
 * Top-level work-item properties addressable by every work-item binding
 * mechanism in the SDK: the default-pipeline-assignment DSL's
 * `workItem.<field>` accessor (`define-default-pipeline-assignment.ts`) and
 * the regular pipeline/step `workItem.<field>` accessor
 * (`builder-helpers.ts`'s `WorkItemAccessor`) — and, reversed, both
 * `boboddy pipelines pull` file generators
 * (`default-pipeline-assignment-file-generator.ts`,
 * `pipeline-file-generator.ts`). `fields` is deliberately excluded from this
 * list: it's reached via `.field(name)` on every one of those accessors, not
 * as a top-level property.
 *
 * This is the single source of truth for the list — it must stay in sync
 * with the `workItem` fact/context shape every corresponding server-side
 * resolver publishes (`buildFacts` in
 * `evaluate-default-pipeline-assignment.ts`; `buildResolvedWorkItemContext`
 * in `resolve-node-input.ts`).
 */
export const WORK_ITEM_TOP_LEVEL_FIELDS = [
  "id",
  "projectId",
  "platform",
  "platformId",
  "platformKey",
  "url",
  "title",
  "description",
  "sourceCreatedAt",
  "sourceUpdatedAt",
  "createdByUserId",
  "parentWorkItemId",
  "createdAt",
  "updatedAt",
] as const;

export type WorkItemTopLevelField = (typeof WORK_ITEM_TOP_LEVEL_FIELDS)[number];

/**
 * The literal union of valid work-item platforms, sourced from the generated
 * OpenAPI response type (`GetApiWorkItemsByWorkItemIdResponses[200]["platform"]`)
 * rather than hand-duplicated, so it cannot drift from the API contract. It
 * must mirror `WorkItemPlatform` in
 * `packages/core/src/work-items/work-item/domain/work-item-platform.ts`.
 */
type WorkItemPlatformLiteral =
  GetApiWorkItemsByWorkItemIdResponses[200]["platform"];

/**
 * Per-field value types for every member of `WORK_ITEM_TOP_LEVEL_FIELDS`,
 * mirroring exactly what the server-side resolvers publish at evaluation/
 * resolution time (`buildFacts` for default-pipeline-assignment;
 * `buildResolvedWorkItemContext` for regular pipeline/step input bindings).
 * Notably, `sourceCreatedAt`/`sourceUpdatedAt`/`createdAt`/`updatedAt` are
 * serialized as ISO date strings (or `null`), never `Date` objects.
 */
export type WorkItemTopLevelFieldTypeMap = {
  id: string;
  projectId: string;
  platform: WorkItemPlatformLiteral;
  platformId: string | null;
  platformKey: string;
  url: string | null;
  title: string;
  description: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  createdByUserId: string | null;
  parentWorkItemId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

// ─── Platform-specific `fields` bag ───────────────────────────────────────────

/**
 * The path prefix marking a reference into a work item's platform-specific
 * `fields` bag (a Jira custom field, a GitHub label, etc.), as opposed to a
 * `WorkItemTopLevelField`. Shared by every accessor that authors these paths
 * (`workItem.field(name)` in both the default-pipeline-assignment DSL and
 * the regular pipeline/step `WorkItemAccessor`) and every resolver that
 * reads them back (`resolveWorkItemFieldPath` below; the JSONPath-rooted
 * variant in `evaluate-default-pipeline-assignment.ts`, which layers a `$.`
 * prefix on top of this same convention).
 */
export const WORK_ITEM_FIELDS_PATH_PREFIX = "fields.";

/**
 * Resolves a work-item path — either a `WorkItemTopLevelField` name (a
 * single, code-controlled segment) or a `fields.<name>` reference into the
 * platform-specific `fields` bag — against a plain object shaped like
 * `WorkItemTopLevelFieldTypeMap & { fields: ... }`.
 *
 * `<name>` in `fields.<name>` is an arbitrary, unescaped, platform-supplied
 * field name (a Jira custom field label, a GitHub key, etc.) that may
 * contain any character, including `.`, `[`, `]`, `~`, `^`, `;`, or even be
 * the empty string. A naive dot-splitting path walker would silently
 * misresolve a field literally named `"a.b"` as nested property access
 * (`fields.a.b`) instead of the flat key `fields["a.b"]` — a silent-wrong-
 * match hazard, not a visible error, since the walker degrades to "no
 * match"/"wrong match" rather than throwing.
 *
 * This resolver sidesteps that hazard entirely: everything after `fields.`
 * is treated as one atomic, unsplit key. Every work-item path resolver in
 * the codebase must use this same convention for a field name to round-trip
 * correctly — see `evaluate-default-pipeline-assignment.ts`'s
 * `resolveWorkItemAssignmentPath` (which layers `$.` path-rooting on top of
 * this function) and `resolve-node-input.ts`'s `work_item` binding
 * resolution (which calls this function directly, replacing what used to be
 * a dot-splitting walker shared with unrelated binding sources and
 * susceptible to the exact hazard described above).
 *
 * `path` is untyped (`string`, not `WorkItemTopLevelField | \`fields.${string}\``)
 * because callers validate membership separately
 * (`WORK_ITEM_TOP_LEVEL_FIELDS`/`isSupportedWorkItemField`) before ever
 * reaching a resolver — this function's contract is purely "resolve
 * whatever path string you hand it, treating `fields.` as atomic," not
 * "validate the path."
 */
// eslint-disable-next-line local/no-unknown-parameter-type -- resolves an arbitrary caller-supplied fact/context object whose shape isn't known here; every caller narrows its own return value.
export function resolveWorkItemFieldPath(record: unknown, path: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  const asRecord = record as Record<string, unknown>;

  if (path.startsWith(WORK_ITEM_FIELDS_PATH_PREFIX)) {
    const fieldName = path.slice(WORK_ITEM_FIELDS_PATH_PREFIX.length);
    const fields = asRecord["fields"];
    if (typeof fields !== "object" || fields === null) return undefined;
    return (fields as Record<string, unknown>)[fieldName];
  }

  return asRecord[path];
}
