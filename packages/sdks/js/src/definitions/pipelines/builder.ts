import { z, type ZodType } from "zod";
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
} from "./define-pipeline";
import {
  literal,
  makeStepInputCtx,
  mergeStepBindings,
  normalizeInputMapping,
  resolveAdditionalStepInputBindings,
  WORK_ITEM_ACCESSOR,
  type AnyTypedStep,
  type PipelineMeta,
  type StepConfig,
  type StepInputCtx,
} from "./builder-helpers";

export type {
  AnyTypedStep,
  PipelineMeta,
  StepConfig,
  StepInputCtx,
  WorkItemAccessor,
} from "./builder-helpers";

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
    protected readonly pipelineStepInputBindings: Record<
      string,
      AnyBinding
    > = {},
  ) {}

  advance(
    callback: (
      ctx: AdvanceCtx<LastSignalKeys<TSteps>, LastSignalTypeMap<TSteps>>,
    ) => AdvanceResult<LastSignalKeys<TSteps>>,
  ): PipelineStepBuilder<TInput, TSteps> {
    // steps is guaranteed non-empty: this object is only created after .step()
    const last = this.steps.at(-1);
    if (!last) throw new Error("Internal error: no steps available");
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
    protected readonly pipelineStepInputBindings: Record<
      string,
      AnyBinding
    > = {},
  ) {}

  step<S extends AnyTypedStep & { __hasAdditionalInput: false }>(
    step: S,
    mapper?: (
      ctx: StepInputCtx<TInput, TSteps>,
    ) => Partial<Record<string, AnyBinding>>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [...TSteps, S]>;
  step<S extends AnyTypedStep>(
    step: S,
    mapper: (ctx: StepInputCtx<TInput, TSteps>) => StepInputMapping<S>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [...TSteps, S]>;
  step<S extends AnyTypedStep>(
    step: S,
    mapper?: (
      ctx: StepInputCtx<TInput, TSteps>,
    ) => Record<string, AnyBinding | undefined>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [...TSteps, S]> {
    const ctx = makeStepInputCtx(this.inputSchema) as unknown as StepInputCtx<
      TInput,
      TSteps
    >;
    const rawInput = mapper ? mapper(ctx) : {};
    const input = mergeStepBindings(
      this.pipelineStepInputBindings,
      normalizeInputMapping(rawInput),
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
    );
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
          Object.keys(additionalPipelineInput.schema.shape),
        );
        const unknown = Object.keys(raw).filter((k) => !validKeys.has(k));
        if (unknown.length > 0) {
          throw new Error(
            `additionalPipelineInput.bindings returned key${unknown.length > 1 ? "s" : ""} not in schema: ${unknown.map((k) => `"${k}"`).join(", ")}`,
          );
        }
      }
      this.pipelineInputBindings = normalizeInputMapping(raw) ?? {};
    } else {
      this.pipelineInputBindings = {};
    }

    this.pipelineStepInputBindings = resolveAdditionalStepInputBindings(
      "additionalStepInput",
      additionalStepInput,
    );
  }

  step<S extends AnyTypedStep & { __hasAdditionalInput: false }>(
    step: S,
    mapper?: (
      ctx: StepInputCtx<TInput, []>,
    ) => Partial<Record<string, AnyBinding>>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [S]>;
  step<S extends AnyTypedStep>(
    step: S,
    mapper: (ctx: StepInputCtx<TInput, []>) => StepInputMapping<S>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [S]>;
  step<S extends AnyTypedStep>(
    step: S,
    mapper?: (
      ctx: StepInputCtx<TInput, []>,
    ) => Record<string, AnyBinding | undefined>,
    configFn?: (config: StepConfig) => void,
  ): PipelineStepAdvancementBuilder<TInput, [S]> {
    const ctx = makeStepInputCtx(this.inputSchema) as StepInputCtx<TInput, []>;
    const rawInput = mapper ? mapper(ctx) : {};
    const input = mergeStepBindings(
      this.pipelineStepInputBindings,
      normalizeInputMapping(rawInput),
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
    );
  }
}

export { literal } from "./builder-helpers";

export function pipeline<TInput extends ZodType = z.ZodUnknown>(
  meta: PipelineMeta<TInput>,
): PipelineBuilder<TInput> {
  return new PipelineBuilder(meta);
}
