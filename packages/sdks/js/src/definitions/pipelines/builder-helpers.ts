import type { TypedStepDefinitionSpec } from "../steps/define-step";
import { type AnyBinding, type LiteralBinding, type WorkItemBinding } from "./define-pipeline";
import {
  WORK_ITEM_FIELDS_PATH_PREFIX,
  WORK_ITEM_TOP_LEVEL_FIELDS,
  type WorkItemTopLevelField,
} from "./work-item-fields";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTypedStep = TypedStepDefinitionSpec<any, any, any, any>;

export type IsAny<T> = 0 extends 1 & T ? true : false;

export type RequiredInputKeys<T extends object> = {
  [K in keyof T & string]-?: undefined extends T[K] ? never : K;
}[keyof T & string];

export type OptionalInputKeys<T extends object> = {
  [K in keyof T & string]-?: undefined extends T[K] ? K : never;
}[keyof T & string];

/**
 * Work-item accessor for a `step`/`fanOut`/`loop`/parallel-branch state's
 * `input` mapper (`ctx.workItem`, `NodeInputCtx` in `node-input-ctx.ts`): a
 * top-level property (`workItem.title`, `workItem.platform`, `workItem.url`,
 * ...) for every member of `WORK_ITEM_TOP_LEVEL_FIELDS`, plus
 * `workItem.field(name)` for the platform-specific `fields` bag.
 *
 * Mirrors the default-pipeline-assignment DSL's `WorkItemAssignmentAccessor`
 * (`define-default-pipeline-assignment.ts`) in which properties it exposes —
 * both are generated off the same `WORK_ITEM_TOP_LEVEL_FIELDS` list — but
 * returns a plain `WorkItemBinding` per property rather than a
 * comparator-bound `AssignmentFieldRef`: a regular pipeline input binding
 * has no conditions to compare against, it's just "read this work-item
 * property into this input field."
 *
 * `field`'s optional `TName` type parameter accepts a literal union of known
 * field names (e.g. the `WorkItemFieldName` type `boboddy pipelines pull`
 * generates into `work-item-fields.ts`) for compile-time validation and
 * autocomplete on the field name, exactly like the assignment DSL's
 * `workItem.field<TName>(...)`. Defaults to permissive `string`, so
 * `workItem.field(name)` with no type argument keeps working as before.
 */
export type WorkItemAccessor = {
  readonly [K in WorkItemTopLevelField]: WorkItemBinding;
} & {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- TName is intentionally single-use: it exists to preserve literal-type inference/autocomplete on the argument, not to relate multiple positions.
  field<TName extends string = string>(fieldName: TName): WorkItemBinding;
};

export const WORK_ITEM_ACCESSOR: WorkItemAccessor = Object.freeze({
  ...Object.fromEntries(
    WORK_ITEM_TOP_LEVEL_FIELDS.map((field) => [
      field,
      Object.freeze({ source: "work_item", field }),
    ]),
  ),
  field: (fieldName: string): WorkItemBinding =>
    Object.freeze({
      source: "work_item",
      field: `${WORK_ITEM_FIELDS_PATH_PREFIX}${fieldName}`,
    }),
}) as WorkItemAccessor;

// eslint-disable-next-line local/no-unknown-parameter-type
export function literal(value: unknown): LiteralBinding {
  return { source: "literal", value };
}

/**
 * Strips `undefined` values out of a node's `input` mapper return value —
 * an author may return `{ foo: someCondition ? binding : undefined }` to
 * conditionally omit a field, which should not become a real
 * `{foo: undefined}` wire entry.
 */
export function normalizeInputMapping(
  mapping: Record<string, AnyBinding | undefined> | undefined,
): Record<string, AnyBinding> {
  const out: Record<string, AnyBinding> = {};
  if (!mapping) return out;
  for (const [key, value] of Object.entries(mapping)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
