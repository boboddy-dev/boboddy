import { z, type ZodType } from "zod";
import type { TypedStepDefinitionSpec } from "../steps/define-step";
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
};

export type StepInputCtx<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
> = {
  input: InputAccessor<TInput["_output"]>;
  workItem: WorkItemAccessor;
  signal: <S extends ElementOf<TSteps>>(
    step: S,
    key: S["__signalKeys"],
  ) => StepSignalBinding;
  output: <S extends ElementOf<TSteps>>(step: S) => StepOutputBinding;
};

export type PipelineMeta<TInput extends ZodType = z.ZodUnknown> = {
  key: string;
  name: string;
  description?: string;
  version?: number;
  status?: "draft" | "active";
  input?: TInput;
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
    protected readonly meta: Omit<PipelineMeta<TInput>, "input">,
    protected readonly steps: PipelineStepConfig[],
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
    return new PipelineStepBuilder(this.inputSchema, this.meta, this.steps);
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
    protected readonly meta: Omit<PipelineMeta<TInput>, "input">,
    protected readonly steps: PipelineStepConfig[],
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
    const input = normalizeInputMapping(
      rawInput as Record<string, AnyBinding | undefined>,
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
  private readonly meta: Omit<PipelineMeta<TInput>, "input">;
  private readonly steps: PipelineStepConfig[] = [];

  constructor(meta: PipelineMeta<TInput>) {
    const { input, ...rest } = meta;
    this.inputSchema = (input ?? z.unknown()) as TInput;
    this.meta = rest;
  }

  step<S extends AnyTypedStep>(
    step: S,
    mapper: (ctx: StepInputCtx<TInput, []>) => StepInputMapping<S>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [S]> {
    const ctx = makeStepInputCtx(this.inputSchema) as StepInputCtx<TInput, []>;
    const rawInput = mapper(ctx);
    const input = normalizeInputMapping(
      rawInput as Record<string, AnyBinding | undefined>,
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
    ) as PipelineStepAdvancementBuilder<TInput, [S]>;
  }

}

const WORK_ITEM_ACCESSOR: WorkItemAccessor = Object.freeze({
  title: Object.freeze({ source: "work_item", field: "title" } as const),
  description: Object.freeze({
    source: "work_item",
    field: "description",
  } as const),
});

function makeStepInputCtx<TInput extends ZodType>(
  inputSchema: TInput,
): StepInputCtx<TInput, ReadonlyArray<AnyTypedStep>> {
  return {
    input: createInputAccessor(inputSchema) as InputAccessor<TInput["_output"]>,
    workItem: WORK_ITEM_ACCESSOR,
    signal<S extends AnyTypedStep>(
      step: S,
      key: S["__signalKeys"],
    ): StepSignalBinding {
      return { source: "step_signal", step, signalKey: key };
    },
    output<S extends AnyTypedStep>(step: S): StepOutputBinding {
      return { source: "step_output", step };
    },
  };
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

export function pipeline<TInput extends ZodType = z.ZodUnknown>(
  meta: PipelineMeta<TInput>,
): PipelineBuilder<TInput> {
  return new PipelineBuilder(meta);
}
