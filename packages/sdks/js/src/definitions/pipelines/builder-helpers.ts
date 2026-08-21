import { z, type ZodType } from "zod";
import {
  type AdditionalStepInputBinding,
  type TypedStepDefinitionSpec,
} from "../steps/define-step";
import {
  type AnyBinding,
  type FanOutItemBinding,
  type LiteralBinding,
  type SignalsListBinding,
  type StepOutputBinding,
  type StepSignalBinding,
  type WorkItemBinding,
} from "./define-pipeline";
import {
  createInputAccessor,
  isInputAccessor,
  materializeAccessor,
  type InputAccessor,
} from "./input-accessor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTypedStep = TypedStepDefinitionSpec<any, any, any, any>;

type ElementOf<T extends ReadonlyArray<unknown>> =
  T extends ReadonlyArray<infer U> ? U : never;

// ─── Step-tuple generic helpers ────────────────────────────────────────────────
//
// `LastSignalKeys` is used by `fan-out-builder.ts`'s `over` config key
// (constrained to the most recent ordinary step's signals) — factored out
// here rather than defined there to sit alongside the other step-tuple
// helpers below, which both `builder.ts` and `fan-out-builder.ts` need.

export type LastStep<T extends ReadonlyArray<AnyTypedStep>> =
  T extends readonly [...AnyTypedStep[], infer L]
    ? L extends AnyTypedStep
      ? L
      : never
    : never;

export type LastSignalKeys<T extends ReadonlyArray<AnyTypedStep>> =
  LastStep<T> extends AnyTypedStep ? LastStep<T>["__signalKeys"] : never;

/**
 * The per-branch `item` type a fan-out's `over` key resolves to (issue
 * #167): `never` unless `K` names a signal on the most recent ordinary step
 * (`LastStep<TSteps>`) whose resolved TS type is itself an array — in which
 * case this is that array's element type. A number-typed signal (count-only
 * mode) resolves to `never`, which is how `FanOutInputCtx` below decides
 * whether `item` exists on the ctx type at all.
 */
export type FanOutItemType<
  TSteps extends ReadonlyArray<AnyTypedStep>,
  K extends string,
> = K extends keyof LastStep<TSteps>["__signalTypeMap"]
  ? LastStep<TSteps>["__signalTypeMap"][K] extends ReadonlyArray<infer Item>
    ? Item
    : never
  : never;

/**
 * A fan-out's own `input` mapper ctx: everything `StepInputCtx` already
 * offers, plus `item` when `FanOutItemType` resolves to something other
 * than `never`. `item`'s exposed type is intersected with `FanOutItemBinding`
 * (the same "phantom binding" trick `WithWorkItemFields`/`InputAccessor`
 * use elsewhere in this file) so it reads as the real per-item TS type
 * (e.g. `string`) to callers while still structurally satisfying `AnyBinding`
 * when assigned straight into a `FanOutInputMapping` field — at runtime it
 * is always the single `{ source: "fan_out_item" }` binding object,
 * regardless of `Item`'s shape.
 */
export type FanOutInputCtx<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
  TFanOuts extends ReadonlyArray<AnyTypedStep>,
  K extends string,
> = StepInputCtx<TInput, TSteps, TFanOuts> &
  (FanOutItemType<TSteps, K> extends never
    ? unknown
    : { item: FanOutItemBinding & FanOutItemType<TSteps, K> });

export type IsAny<T> = 0 extends 1 & T ? true : false;

export type WorkItemAccessor = {
  readonly title: WorkItemBinding;
  readonly description: WorkItemBinding;
  readonly field: (fieldName: string) => WorkItemBinding;
};

export type PinnedWorkItemComment = {
  createdAt: string;
  body: string;
};

export type WithWorkItemFields<T> = {
  workItemTitle: string;
  workItemDescription: string | null;
  // Auto-injected pinned work item comments (chronological). Unlike
  // workItemTitle/workItemDescription this is NOT a `work_item` scalar binding;
  // it is injected on the resolved step input at runtime and has no binding form.
  workItemComments: PinnedWorkItemComment[];
} & T;

export type RequiredInputKeys<T extends object> = {
  [K in keyof T & string]-?: undefined extends T[K] ? never : K;
}[keyof T & string];

export type OptionalInputKeys<T extends object> = {
  [K in keyof T & string]-?: undefined extends T[K] ? K : never;
}[keyof T & string];

type Prettify<T> = { [K in keyof T]: T[K] } & {};

export type StepInputCtx<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
  TFanOuts extends ReadonlyArray<AnyTypedStep> = [],
> = {
  input: InputAccessor<Prettify<WithWorkItemFields<TInput["_output"]>>>;
  signal: <S extends ElementOf<TSteps>>(
    step: S,
    key: S["__signalKeys"],
  ) => StepSignalBinding;
  output: (step: ElementOf<TSteps>) => StepOutputBinding;
  // eslint-disable-next-line local/no-unknown-parameter-type
  literal: (value: unknown) => LiteralBinding;
  /**
   * Reaches a fan-out's whole cohort — every terminal branch's own signals
   * + output, resolved server-side — from a later, non-adjacent step's
   * input mapper (issue #167). `fanOutStep` is constrained to a fan-out
   * step already seen earlier in this pipeline (`.fanOutStep(fanOutStep, ...)`),
   * the same way `signal`/`output` are constrained to `TSteps`.
   */
  signalsList: (fanOutStep: ElementOf<TFanOuts>) => SignalsListBinding;
};

type ReservedPipelineInputKeys =
  "workItemTitle" | "workItemDescription" | "workItemComments";

// Resolves to T when the schema shape has none of the reserved keys, never otherwise.
// Uses `.shape` (the raw key map on ZodObject) rather than `_output` to avoid a
// Zod v4 quirk where empty-object strip-mode output is `Record<string, never>`.
// Non-object schemas (no `.shape`) pass through unconditionally.
export type NoReservedKeys<T extends ZodType> = T extends { shape: infer Shape }
  ? [keyof Shape & ReservedPipelineInputKeys] extends [never]
    ? T
    : never
  : T;

export type PipelineMeta<TInput extends ZodType = z.ZodUnknown> = {
  key: string;
  name: string;
  description?: string;
  version?: number;
  status?: "draft" | "active";
  additionalPipelineInput?: {
    schema: NoReservedKeys<TInput>;
    bindings: (ctx: {
      workItem: WorkItemAccessor;
      // eslint-disable-next-line local/no-unknown-parameter-type
      literal: (value: unknown) => LiteralBinding;
    }) => TInput["_output"] extends object
      ? { [K in RequiredInputKeys<TInput["_output"]>]: AnyBinding } & {
          [K in OptionalInputKeys<TInput["_output"]>]?: AnyBinding;
        }
      : Partial<Record<string, AnyBinding>>;
  };
  additionalStepInput?: {
    schema: ZodType;
    bindings: (ctx: {
      workItemField: (fieldName: string) => WorkItemBinding;
      // eslint-disable-next-line local/no-unknown-parameter-type
      literal: (value: unknown) => LiteralBinding;
    }) => Partial<Record<string, AdditionalStepInputBinding>>;
  };
};

export const WORK_ITEM_ACCESSOR: WorkItemAccessor = Object.freeze({
  title: Object.freeze({ source: "work_item", field: "title" } as const),
  description: Object.freeze({
    source: "work_item",
    field: "description",
  } as const),
  field: (fieldName: string): WorkItemBinding =>
    Object.freeze({ source: "work_item", field: `fields.${fieldName}` }),
});

const WORK_ITEM_FIELD_BINDINGS: Record<string, WorkItemBinding> = {
  workItemTitle: { source: "work_item", field: "title" },
  workItemDescription: { source: "work_item", field: "description" },
};

export function makeStepInputCtx<TInput extends ZodType>(
  inputSchema: TInput,
): StepInputCtx<
  TInput,
  ReadonlyArray<AnyTypedStep>,
  ReadonlyArray<AnyTypedStep>
> {
  const baseAccessor = createInputAccessor(inputSchema);
  const input = new Proxy(baseAccessor, {
    get(target, prop) {
      if (typeof prop === "string" && prop in WORK_ITEM_FIELD_BINDINGS) {
        return WORK_ITEM_FIELD_BINDINGS[prop];
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
      return (target as any)[prop];
    },
  }) as InputAccessor<WithWorkItemFields<TInput["_output"]>>;

  return {
    input,
    signal<S extends AnyTypedStep>(
      step: S,
      key: S["__signalKeys"],
    ): StepSignalBinding {
      return { source: "step_signal", step, signalKey: key };
    },
    output(step: AnyTypedStep): StepOutputBinding {
      return { source: "step_output", step };
    },
    literal,
    signalsList(fanOutStep: AnyTypedStep): SignalsListBinding {
      return { source: "signals_list", fanOutStep };
    },
  };
}

// eslint-disable-next-line local/no-unknown-parameter-type
export function literal(value: unknown): LiteralBinding {
  return { source: "literal", value };
}

export function normalizeInputMapping(
  mapping: Record<string, AnyBinding | undefined> | undefined,
): Record<string, AnyBinding> | undefined {
  if (!mapping) return undefined;
  const out: Record<string, AnyBinding> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value === undefined) continue;
    out[key] = isInputAccessor(value) ? materializeAccessor(value) : value;
  }
  return out;
}

export function resolveAdditionalStepInputBindings(
  label: "additionalStepInput",
  definition: PipelineMeta["additionalStepInput"] | undefined,
): Record<string, AnyBinding> {
  if (!definition) {
    return {};
  }

  const raw = definition.bindings({
    workItemField: (fieldName: string) => ({
      source: "work_item",
      field: `fields.${fieldName}`,
    }),
    literal,
  });

  if (definition.schema instanceof z.ZodObject) {
    const validKeys = new Set(Object.keys(definition.schema.shape));
    const unknown = Object.keys(raw).filter((key) => !validKeys.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `${label}.bindings returned key${unknown.length > 1 ? "s" : ""} not in schema: ${unknown.map((key) => `"${key}"`).join(", ")}`,
      );
    }
  }

  return normalizeInputMapping(raw) ?? {};
}

export function mergeStepBindings(
  pipelineBindings: Record<string, AnyBinding>,
  explicitBindings: Record<string, AnyBinding> | undefined,
): Record<string, AnyBinding> | undefined {
  const merged = {
    ...pipelineBindings,
    ...(explicitBindings ?? {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}
