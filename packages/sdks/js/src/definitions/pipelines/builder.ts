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
  type PipelineNodeConfig,
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
  type IsAny,
  type LastSignalKeys,
  type OptionalInputKeys,
  type PipelineMeta,
  type RequiredInputKeys,
  type StepInputCtx,
} from "./builder-helpers";
import { beginFanOut, type FanOutStepConfig } from "./fan-out-builder";

export type {
  AnyTypedStep,
  PipelineMeta,
  StepInputCtx,
  WorkItemAccessor,
} from "./builder-helpers";
export {
  type FanOutStepConfig,
  type FanOutInputMapping,
} from "./fan-out-builder";

type StepInputMapping<S extends AnyTypedStep> =
  IsAny<S["__inputType"]> extends true
    ? Partial<Record<string, AnyBinding>>
    : S["__inputType"] extends object
      ? { [K in RequiredInputKeys<S["__inputType"]>]: AnyBinding } & {
          [K in OptionalInputKeys<S["__inputType"]>]?: AnyBinding;
        }
      : Partial<Record<string, AnyBinding>>;

/**
 * `.step()`'s single options argument. Deliberately a single generic type
 * (not a set of overload signatures split on `S["__hasAdditionalInput"]`):
 * with overloads, a mistake inside `options.input`'s return value fails
 * every overload, and TS reports "no overload matches" against the whole
 * call rather than pointing at the specific missing/wrong property inside
 * `input`'s return type. A single signature lets TS check `options`
 * structurally in one pass and localize the error correctly.
 */
type StepOptions<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
  TFanOuts extends ReadonlyArray<AnyTypedStep>,
  S extends AnyTypedStep,
> = (S extends { __hasAdditionalInput: false }
  ? {
      input?: (
        ctx: StepInputCtx<TInput, TSteps, TFanOuts>,
      ) => Partial<Record<string, AnyBinding>>;
    }
  : {
      input: (
        ctx: StepInputCtx<TInput, TSteps, TFanOuts>,
      ) => StepInputMapping<S>;
    }) & {
  advance: (
    ctx: AdvanceCtx<S["__signalKeys"], S["__signalTypeMap"]>,
  ) => AdvanceResult<S["__signalKeys"]>;
  timeout?: number | null;
};

/**
 * Pushes a step node onto `nodes` and resolves its advancement policy in one
 * call — shared by `PipelineBuilder.step()` (the entry point, `TSteps = []`)
 * and `PipelineStepBuilder.step()` (every step after the first), which are
 * otherwise identical apart from what history they carry.
 */
function pushStep<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
  TFanOuts extends ReadonlyArray<AnyTypedStep>,
  S extends AnyTypedStep,
>(
  inputSchema: TInput,
  meta: Omit<
    PipelineMeta<TInput>,
    "additionalPipelineInput" | "additionalStepInput"
  >,
  nodes: PipelineNodeConfig[],
  pipelineInputBindings: Record<string, AnyBinding>,
  pipelineStepInputBindings: Record<string, AnyBinding>,
  step: S,
  rawOptions: StepOptions<TInput, TSteps, TFanOuts, S>,
): PipelineStepBuilder<TInput, [...TSteps, S], TFanOuts> {
  // `StepOptions` is a conditional type over the (here, still-generic) `S`,
  // so it can't be indexed directly inside a generic function body — cast
  // once to the shape actually needed at runtime, which is the same for
  // both branches of the conditional.
  const options = rawOptions as {
    input?: (
      ctx: StepInputCtx<TInput, TSteps, TFanOuts>,
    ) => Record<string, AnyBinding | undefined>;
    advance: (
      ctx: AdvanceCtx<S["__signalKeys"], S["__signalTypeMap"]>,
    ) => AdvanceResult<S["__signalKeys"]>;
    timeout?: number | null;
  };
  const ctx = makeStepInputCtx(inputSchema) as unknown as StepInputCtx<
    TInput,
    TSteps,
    TFanOuts
  >;
  const rawInput = options.input ? options.input(ctx) : {};
  const input = mergeStepBindings(
    pipelineStepInputBindings,
    normalizeInputMapping(rawInput),
  );
  const stepConfig: PipelineStepConfig = { step, input };
  if (options.timeout !== undefined) stepConfig.timeout = options.timeout;

  const advanceCtx = makeAdvanceCtx<S["__signalKeys"], S["__signalTypeMap"]>();
  const result = options.advance(advanceCtx);
  const policy: AdvancementPolicy<S["__signalKeys"]> = {
    defaultOutcome: result.default,
    ...(result.rules !== undefined ? { rules: result.rules } : {}),
  };
  stepConfig.advancement = policy as AdvancementPolicy;

  nodes.push(stepConfig);
  return new PipelineStepBuilder(
    inputSchema,
    meta,
    nodes,
    pipelineInputBindings,
    pipelineStepInputBindings,
  );
}

/**
 * Returned by `.step()`/`pipeline()`. Provides `.step()` to chain the next
 * step, `.fanOutStep()` to begin a fan-out+cohort-gate pair (issue #167),
 * and `.build()` to finalize. `.step()` requires an `advance` callback in
 * its options — deciding how the pipeline continues past this step — as
 * part of the same call that declares the step's input, rather than as a
 * separate chained method on an intermediate builder class.
 */
export class PipelineStepBuilder<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
  TFanOuts extends ReadonlyArray<AnyTypedStep> = [],
> {
  declare readonly __steps: TSteps;
  declare readonly __fanOuts: TFanOuts;

  constructor(
    protected readonly inputSchema: TInput,
    protected readonly meta: Omit<
      PipelineMeta<TInput>,
      "additionalPipelineInput" | "additionalStepInput"
    >,
    protected readonly nodes: PipelineNodeConfig[],
    protected readonly pipelineInputBindings: Record<string, AnyBinding> = {},
    protected readonly pipelineStepInputBindings: Record<
      string,
      AnyBinding
    > = {},
  ) {}

  step<S extends AnyTypedStep>(
    step: S,
    options: StepOptions<TInput, TSteps, TFanOuts, S>,
  ): PipelineStepBuilder<TInput, [...TSteps, S], TFanOuts> {
    return pushStep(
      this.inputSchema,
      this.meta,
      this.nodes,
      this.pipelineInputBindings,
      this.pipelineStepInputBindings,
      step,
      options,
    );
  }

  /**
   * Begins a fan-out+cohort-gate pair (issue #167): `step` is the template
   * every branch executes, with its branch count (and, when `over` names
   * an array-typed signal, each branch's own typed `item`) resolved at
   * runtime from `config.over` (a signal on the step immediately
   * preceding this fan-out). `config` requires both `advance` (each
   * branch's own continue/block decision) and `advanceAll` (the
   * whole-cohort decision — a pure gate, not a step; nothing besides the
   * fan-out+gate pair itself is appended to the pipeline's node sequence)
   * up front, mirroring how `.step()` requires `advance` in its own
   * options rather than as a separate chained call.
   */
  fanOutStep<S extends AnyTypedStep, K extends LastSignalKeys<TSteps>>(
    step: S,
    config: FanOutStepConfig<TInput, TSteps, TFanOuts, S, K>,
  ): PipelineStepBuilder<TInput, TSteps, [...TFanOuts, S]> {
    return beginFanOut(
      this.inputSchema,
      this.meta,
      this.nodes,
      this.pipelineInputBindings,
      this.pipelineStepInputBindings,
      step,
      config,
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
      nodes: this.nodes,
      pipelineInputBindings: this.pipelineInputBindings,
    };
    return buildPipelineSpec(config);
  }
}

/**
 * Entry-point builder returned by `pipeline()`. Only exposes `.step()` —
 * call that to receive a `PipelineStepBuilder`, which chains further
 * `.step()`/`.fanOutStep()` calls or finalizes with `.build()`.
 */
export class PipelineBuilder<TInput extends ZodType> {
  private readonly inputSchema: TInput;
  private readonly meta: Omit<
    PipelineMeta<TInput>,
    "additionalPipelineInput" | "additionalStepInput"
  >;
  private readonly nodes: PipelineNodeConfig[] = [];
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

  step<S extends AnyTypedStep>(
    step: S,
    options: StepOptions<TInput, [], [], S>,
  ): PipelineStepBuilder<TInput, [S]> {
    return pushStep(
      this.inputSchema,
      this.meta,
      this.nodes,
      this.pipelineInputBindings,
      this.pipelineStepInputBindings,
      step,
      options,
    );
  }
}

export { literal } from "./builder-helpers";

export function pipeline<TInput extends ZodType = z.ZodUnknown>(
  meta: PipelineMeta<TInput>,
): PipelineBuilder<TInput> {
  return new PipelineBuilder(meta);
}
