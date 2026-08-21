import type { ZodType } from "zod";
import {
  makeAdvanceAllCtx,
  makeAdvanceEachCtx,
  type AdvanceAllCtx,
  type AdvanceAllResult,
  type AdvanceEachCtx,
  type AdvanceEachResult,
} from "../advancement-policies/cohort-fluent-rules";
import type { CohortAdvancementPolicy } from "../advancement-policies/cohort-advancement-policy";
import {
  mergeStepBindings,
  normalizeInputMapping,
  makeStepInputCtx,
  type AnyTypedStep,
  type FanOutInputCtx,
  type IsAny,
  type LastSignalKeys,
  type PipelineMeta,
  type RequiredInputKeys,
} from "./builder-helpers";
import type {
  AnyBinding,
  PipelineCohortGateNodeConfig,
  PipelineFanOutStepConfig,
  PipelineNodeConfig,
} from "./define-pipeline";
import { PipelineStepBuilder } from "./builder";

/**
 * `.fanOutStep()` (issue #167) split out of `builder.ts` (which would
 * otherwise exceed this repo's `max-lines` limit) — genuinely mutually
 * referential with `PipelineStepBuilder` (`beginFanOut` both is called from
 * `PipelineStepBuilder.fanOutStep()` and returns a new one), so the import
 * cycle is structural, not accidental.
 */

export type FanOutInputMapping<S extends AnyTypedStep> = Partial<
  Record<string, AnyBinding>
> &
  (IsAny<S["__inputType"]> extends true
    ? unknown
    : S["__inputType"] extends object
      ? { [K in RequiredInputKeys<S["__inputType"]>]: AnyBinding }
      : unknown);

/**
 * `.fanOutStep(step, config)`'s sole config argument — `step` itself is a
 * separate positional argument (mirroring `.step(step, options)`), not a
 * field on this object. `K` is inferred from the literal value of
 * `config.over` in the same pass TypeScript type-checks `config.input`,
 * the same mechanism `builder.ts`'s `StepOptions` already relies on for
 * `.step()` — see that type's doc comment for why overloads are avoided
 * here too.
 */
export type FanOutStepConfig<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
  TFanOuts extends ReadonlyArray<AnyTypedStep>,
  S extends AnyTypedStep,
  K extends LastSignalKeys<TSteps> = LastSignalKeys<TSteps>,
> = {
  /**
   * The signal to resolve each branch from — constrained to the most
   * recent ordinary step's declared signal keys (`TSteps`'s last element).
   * Note this is the last *step*, not necessarily the fan-out's immediate
   * graph predecessor: chaining a second `.fanOutStep()` right after
   * `.advanceAll()` (with no intervening `.step()`) still only offers this
   * same step's signals, since a `cohortGate` node produces no signals of
   * its own to resolve from.
   *
   * A number-typed signal resolves a fixed branch count with no `item` on
   * the input ctx (count-only mode); an array-typed signal resolves branch
   * count from the array's length and adds a typed `item` to the input
   * ctx for each branch.
   */
  over: K;
  input?: (
    ctx: FanOutInputCtx<TInput, TSteps, TFanOuts, K>,
  ) => FanOutInputMapping<S>;
  /**
   * Every branch's own continue/block decision (even the default "always
   * continue" must be declared explicitly) — evaluated once per branch
   * against that branch's own signals.
   */
  advance: (
    ctx: AdvanceEachCtx<S["__signalKeys"], S["__signalTypeMap"]>,
  ) => AdvanceEachResult;
  /**
   * The whole-cohort decision, evaluated once the fan-out's branches have
   * settled — a pure gate, not a step: nothing besides the fan-out+gate
   * pair itself is appended to the pipeline's node sequence.
   */
  advanceAll: (ctx: AdvanceAllCtx) => AdvanceAllResult;
  timeout?: number | null;
};

/**
 * Builds and pushes the `fanOut`+`cohortGate` node pair, resolves both the
 * per-branch (`advance`) and whole-cohort (`advanceAll`) policies from
 * `config`, and returns straight into a `PipelineStepBuilder` — mirroring
 * how `pushStep` in `builder.ts` resolves a step's `advance` policy inline
 * rather than through a chained `.advance()` call on an intermediate
 * builder. Called from `PipelineStepBuilder.fanOutStep()` — factored out
 * here (rather than inlined there) purely to keep the node-construction
 * logic next to the types it feeds.
 */
export function beginFanOut<
  TInput extends ZodType,
  TSteps extends ReadonlyArray<AnyTypedStep>,
  TFanOuts extends ReadonlyArray<AnyTypedStep>,
  S extends AnyTypedStep,
  K extends LastSignalKeys<TSteps> = LastSignalKeys<TSteps>,
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
  config: FanOutStepConfig<TInput, TSteps, TFanOuts, S, K>,
): PipelineStepBuilder<TInput, TSteps, [...TFanOuts, S]> {
  const baseCtx = makeStepInputCtx(inputSchema);
  // `item` is always attached to the runtime ctx object — the same binding
  // regardless of `config.over`'s resolved cardinality mode — and is hidden
  // from the input mapper's type-checked parameter type entirely when
  // `FanOutItemType` resolves to `never` (count-only mode). See
  // `FanOutInputCtx`'s doc comment in `builder-helpers.ts`.
  const ctx = {
    ...baseCtx,
    item: { source: "fan_out_item" as const },
  } as unknown as FanOutInputCtx<TInput, TSteps, TFanOuts, K>;
  const rawInput = config.input
    ? (config.input(ctx) as Record<string, AnyBinding | undefined>)
    : {};
  const input = mergeStepBindings(
    pipelineStepInputBindings,
    normalizeInputMapping(rawInput),
  );

  const fanOutNodeConfig: PipelineFanOutStepConfig = {
    nodeType: "fanOut",
    fanOutStep: step,
    overSignalKey: config.over,
    ...(input ? { input } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  };

  const advanceEachCtx = makeAdvanceEachCtx<
    S["__signalKeys"],
    S["__signalTypeMap"]
  >();
  const advanceEachResult = config.advance(advanceEachCtx);
  const advanceEachPolicy: CohortAdvancementPolicy = {
    default: advanceEachResult.default,
    ...(advanceEachResult.rules !== undefined
      ? { rules: advanceEachResult.rules }
      : {}),
  };
  fanOutNodeConfig.advanceEach = advanceEachPolicy;

  const cohortGateNodeConfig: PipelineCohortGateNodeConfig = {
    nodeType: "cohortGate",
    nodeKey: `${step.key}__cohortGate`,
  };

  const advanceAllCtx = makeAdvanceAllCtx();
  const advanceAllResult = config.advanceAll(advanceAllCtx);
  const advanceAllPolicy: CohortAdvancementPolicy = {
    default: advanceAllResult.default,
    ...(advanceAllResult.rules !== undefined
      ? { rules: advanceAllResult.rules }
      : {}),
  };
  cohortGateNodeConfig.advanceAll = advanceAllPolicy;

  // Pushed as a pair, consecutively: `buildChainDependencyEdges` wires the
  // fanOut -> cohortGate edge for free from declaration order alone, no
  // chain-graph.ts changes needed.
  nodes.push(fanOutNodeConfig, cohortGateNodeConfig);

  return new PipelineStepBuilder(
    inputSchema,
    meta,
    nodes,
    pipelineInputBindings,
    pipelineStepInputBindings,
  );
}
