import { z, type ZodType } from "zod";
import {
  getAdditionalStepInputBindings,
  type AdditionalStepInputBinding,
  type TypedStepDefinitionSpec,
} from "../steps/define-step";
import type { AdvancementPolicy } from "../advancement-policies/define-advancement-policy";
import {
  makeAdvanceCtx,
  type AdvanceCtx,
  type AdvanceResult,
} from "../advancement-policies/fluent-rules";
import {
  buildPipelineSpec,
  type AnyBinding,
  type DefinePipelineInput,
  type LiteralBinding,
  type PipelineDefinitionSpec,
  type PipelineStepConfig,
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
type AnyTypedStep = TypedStepDefinitionSpec<any, any, any, any>;

export type StepConfig = {
  timeout?: number | null;
};

type ElementOf<T extends ReadonlyArray<unknown>> =
  T extends ReadonlyArray<infer U> ? U : never;

type LastStep<T extends ReadonlyArray<AnyTypedStep>> = T extends readonly [
  ...AnyTypedStep[],
  infer L,
]
  ? L extends AnyTypedStep
    ? L
    : never
  : never;

type LastSignalKeys<T extends ReadonlyArray<AnyTypedStep>> =
  LastStep<T> extends AnyTypedStep ? LastStep<T>["__signalKeys"] : never;

type LastSignalTypeMap<T extends ReadonlyArray<AnyTypedStep>> =
  LastStep<T> extends AnyTypedStep
    ? LastStep<T>["__signalTypeMap"]
    : Record<string, unknown>;

type IsAny<T> = 0 extends 1 & T ? true : false;

type Prettify<T> = { [K in keyof T]: T[K] } & {};

type RequiredInputKeys<T extends object> = {
  [K in keyof T & string]-?: undefined extends T[K] ? never : K;
}[keyof T & string];

type OptionalInputKeys<T extends object> = {
  [K in keyof T & string]-?: undefined extends T[K] ? K : never;
}[keyof T & string];

type StepInputMapping<S extends AnyTypedStep> =
  IsAny<S["__inputType"]> extends true
    ? Partial<Record<string, AnyBinding>>
    : S["__inputType"] extends object
      ? { [K in RequiredInputKeys<S["__inputType"]>]: AnyBinding } & {
          [K in OptionalInputKeys<S["__inputType"]>]?: AnyBinding;
        }
      : Partial<Record<string, AnyBinding>>;

export type WorkItemAccessor = {
  readonly title: WorkItemBinding;
  readonly description: WorkItemBinding;
  readonly field: (fieldName: string) => WorkItemBinding;
};

type WithWorkItemFields<T> = {
  workItemTitle: string;
  workItemDescription: string | null;
} & T;

export type StepInputCtx<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
> = {
  input: InputAccessor<Prettify<WithWorkItemFields<TInput["_output"]>>>;
  signal: <S extends ElementOf<TSteps>>(
    step: S,
    key: S["__signalKeys"],
  ) => StepSignalBinding;
  output: <S extends ElementOf<TSteps>>(step: S) => StepOutputBinding;
  literal: (value: unknown) => LiteralBinding;
};

type ReservedPipelineInputKeys = "workItemTitle" | "workItemDescription";

// Resolves to T when the schema shape has none of the reserved keys, never otherwise.
// Uses `.shape` (the raw key map on ZodObject) rather than `_output` to avoid a
// Zod v4 quirk where empty-object strip-mode output is `Record<string, never>`.
// Non-object schemas (no `.shape`) pass through unconditionally.
type NoReservedKeys<T extends ZodType> = T extends { shape: infer Shape }
  ? [string & keyof Shape & ReservedPipelineInputKeys] extends [never]
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
      literal: (value: unknown) => LiteralBinding;
    }) => Partial<Record<string, AdditionalStepInputBinding>>;
  };
};

/**
 * Returned by `.step()`. Requires `.advance()` before the pipeline can
 * continue. Also accepts `.timeout()` before `.advance()`.
 */
export class PipelineStepAdvancementBuilder<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
> {
  declare readonly __steps: TSteps;

  constructor(
    protected readonly inputSchema: TInput,
    protected readonly meta: Omit<
      PipelineMeta<TInput>,
      "additionalPipelineInput" | "additionalStepInput"
    >,
    protected readonly steps: PipelineStepConfig[],
    protected readonly pipelineInputBindings: Record<string, AnyBinding> = {},
    protected readonly pipelineStepInputBindings: Record<string, AnyBinding> = {},
  ) {}

  advance(
    callback: (
      ctx: AdvanceCtx<LastSignalKeys<TSteps>, LastSignalTypeMap<TSteps>>,
    ) => AdvanceResult<LastSignalKeys<TSteps>>,
  ): PipelineStepBuilder<TInput, TSteps> {
    // steps is guaranteed non-empty: this object is only created after .step()
    const last = this.steps.at(-1)!;
    const ctx = makeAdvanceCtx<
      LastSignalKeys<TSteps>,
      LastSignalTypeMap<TSteps>
    >();
    const result = callback(ctx);
    const policy: AdvancementPolicy<LastSignalKeys<TSteps>> = {
      defaultOutcome: result.default,
      ...(result.rules !== undefined ? { rules: result.rules } : {}),
    };
    last.advancement = policy as AdvancementPolicy;
    return new PipelineStepBuilder(
      this.inputSchema,
        this.meta,
        this.steps,
        this.pipelineInputBindings,
        this.pipelineStepInputBindings,
      );
  }
}

/**
 * Returned by `.advance()`. Provides `.step()` to chain additional steps,
 * `.timeout()` to set timeout after advancing, and `.build()` to finalize.
 */
export class PipelineStepBuilder<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
> {
  declare readonly __steps: TSteps;

  constructor(
    protected readonly inputSchema: TInput,
    protected readonly meta: Omit<
      PipelineMeta<TInput>,
      "additionalPipelineInput" | "additionalStepInput"
    >,
    protected readonly steps: PipelineStepConfig[],
    protected readonly pipelineInputBindings: Record<string, AnyBinding> = {},
    protected readonly pipelineStepInputBindings: Record<string, AnyBinding> = {},
  ) {}

  step<S extends AnyTypedStep>(
    step: S,
    mapper: (ctx: StepInputCtx<TInput, TSteps>) => StepInputMapping<S>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [...TSteps, S]> {
    const ctx = makeStepInputCtx(this.inputSchema) as unknown as StepInputCtx<
      TInput,
      TSteps
    >;
    const rawInput = mapper(ctx);
    const input = mergeStepBindings(
      getAdditionalStepInputBindings(step),
      this.pipelineStepInputBindings,
      normalizeInputMapping(rawInput as Record<string, AnyBinding | undefined>),
    );
    const stepConfig: PipelineStepConfig = { step, input };
    if (configFn) {
      const cfg: StepConfig = {};
      configFn(cfg);
      if (cfg.timeout !== undefined) stepConfig.timeout = cfg.timeout;
    }
    this.steps.push(stepConfig);
    return new PipelineStepAdvancementBuilder(
      this.inputSchema,
      this.meta,
      this.steps,
      this.pipelineInputBindings,
      this.pipelineStepInputBindings,
    ) as PipelineStepAdvancementBuilder<TInput, [...TSteps, S]>;
  }

  build(): PipelineDefinitionSpec {
    const config: DefinePipelineInput = {
      key: this.meta.key,
      name: this.meta.name,
      description: this.meta.description,
      version: this.meta.version,
      status: this.meta.status,
      input: this.inputSchema,
      steps: this.steps,
      pipelineInputBindings: this.pipelineInputBindings,
    };
    return buildPipelineSpec(config);
  }
}

/**
 * Entry-point builder returned by `pipeline()`. Only exposes `.step()` —
 * call that to receive a `PipelineStepAdvancementBuilder` which requires
 * `.advance()` before the pipeline can proceed.
 */
export class PipelineBuilder<TInput extends ZodType> {
  private readonly inputSchema: TInput;
  private readonly meta: Omit<
    PipelineMeta<TInput>,
    "additionalPipelineInput" | "additionalStepInput"
  >;
  private readonly steps: PipelineStepConfig[] = [];
  private readonly pipelineInputBindings: Record<string, AnyBinding>;
  private readonly pipelineStepInputBindings: Record<string, AnyBinding>;

  constructor(meta: PipelineMeta<TInput>) {
    const { additionalPipelineInput, additionalStepInput, ...rest } = meta;
    this.inputSchema = (additionalPipelineInput?.schema ??
      z.unknown()) as TInput;
    this.meta = rest;
    if (additionalPipelineInput) {
      const raw = additionalPipelineInput.bindings({
        workItem: WORK_ITEM_ACCESSOR,
        literal,
      });
      if (additionalPipelineInput.schema instanceof z.ZodObject) {
        const validKeys = new Set(
          Object.keys(additionalPipelineInput.schema.shape as object),
        );
        const unknown = Object.keys(raw).filter((k) => !validKeys.has(k));
        if (unknown.length > 0) {
          throw new Error(
            `additionalPipelineInput.bindings returned key${unknown.length > 1 ? "s" : ""} not in schema: ${unknown.map((k) => `"${k}"`).join(", ")}`,
          );
        }
      }
      this.pipelineInputBindings =
        normalizeInputMapping(raw as Record<string, AnyBinding | undefined>) ??
        {};
    } else {
      this.pipelineInputBindings = {};
    }

    this.pipelineStepInputBindings = resolveAdditionalStepInputBindings(
      "additionalStepInput",
      additionalStepInput,
    );
  }

  step<S extends AnyTypedStep>(
    step: S,
    mapper: (ctx: StepInputCtx<TInput, []>) => StepInputMapping<S>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [S]> {
    const ctx = makeStepInputCtx(this.inputSchema) as StepInputCtx<TInput, []>;
    const rawInput = mapper(ctx);
    const input = mergeStepBindings(
      getAdditionalStepInputBindings(step),
      this.pipelineStepInputBindings,
      normalizeInputMapping(rawInput as Record<string, AnyBinding | undefined>),
    );
    const stepConfig: PipelineStepConfig = { step, input };
    if (configFn) {
      const cfg: StepConfig = {};
      configFn(cfg);
      if (cfg.timeout !== undefined) stepConfig.timeout = cfg.timeout;
    }
    this.steps.push(stepConfig);
    return new PipelineStepAdvancementBuilder(
      this.inputSchema,
      this.meta,
      this.steps,
      this.pipelineInputBindings,
      this.pipelineStepInputBindings,
    ) as PipelineStepAdvancementBuilder<TInput, [S]>;
  }
}

const WORK_ITEM_ACCESSOR: WorkItemAccessor = Object.freeze({
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

function makeStepInputCtx<TInput extends ZodType>(
  inputSchema: TInput,
): StepInputCtx<TInput, ReadonlyArray<AnyTypedStep>> {
  const baseAccessor = createInputAccessor(inputSchema);
  const input = new Proxy(baseAccessor, {
    get(target, prop) {
      if (typeof prop === "string" && prop in WORK_ITEM_FIELD_BINDINGS) {
        return WORK_ITEM_FIELD_BINDINGS[prop];
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    output<S extends AnyTypedStep>(step: S): StepOutputBinding {
      return { source: "step_output", step };
    },
    literal,
  };
}

export function literal(value: unknown): LiteralBinding {
  return { source: "literal", value };
}

function normalizeInputMapping(
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

function resolveAdditionalStepInputBindings(
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
    const validKeys = new Set(Object.keys(definition.schema.shape as object));
    const unknown = Object.keys(raw).filter((key) => !validKeys.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `${label}.bindings returned key${unknown.length > 1 ? "s" : ""} not in schema: ${unknown.map((key) => `"${key}"`).join(", ")}`,
      );
    }
  }

  return normalizeInputMapping(raw as Record<string, AnyBinding | undefined>) ?? {};
}

function mergeStepBindings(
  stepBindings: Record<string, AnyBinding>,
  pipelineBindings: Record<string, AnyBinding>,
  explicitBindings: Record<string, AnyBinding> | undefined,
): Record<string, AnyBinding> | undefined {
  const merged = {
    ...stepBindings,
    ...pipelineBindings,
    ...(explicitBindings ?? {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function pipeline<TInput extends ZodType = z.ZodUnknown>(
  meta: PipelineMeta<TInput>,
): PipelineBuilder<TInput> {
  return new PipelineBuilder(meta);
}
