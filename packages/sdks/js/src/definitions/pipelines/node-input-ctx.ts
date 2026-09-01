import type { ZodType } from "zod";
import type { DotPaths } from "../steps/define-step";
import { literal, WORK_ITEM_ACCESSOR, type WorkItemAccessor } from "./builder-helpers";
import type {
  FanOutItemBinding,
  LiteralBinding,
  PipelineInputBinding,
  SignalsListBinding,
  StepOutputBinding,
  StepSignalBinding,
} from "./bindings";

/**
 * The `input:` mapper ctx every `step`/`fanOut`/`loop`/parallel-branch
 * state receives (see docs/research/flat-pipeline-sdk-and-visual-designer.md
 * §4). Nodes are addressed by their plain string state key rather than a
 * typed step reference — the flat, forward-only authoring model has no
 * "tuple of prior steps" to statically check a binding's source/signal
 * key against (cross-node static proof is explicitly out of scope; see
 * that doc's §1).
 */
export type NodeInputCtx<TInput extends ZodType = ZodType> = {
  /** Reads a value from the pipeline's own input, by dot-path. */
  pipelineInput: (path: DotPaths<TInput["_output"]>) => PipelineInputBinding;
  workItem: WorkItemAccessor;
  /** Reads a signal declared by an earlier node, addressed by its state key. */
  signal: (nodeKey: string, signalKey: string) => StepSignalBinding;
  /** Reads an earlier node's whole result output, addressed by its state key. */
  output: (nodeKey: string) => StepOutputBinding;
  /** Reaches a fan-out's whole cohort (every terminal branch's signals + output). */
  signalsList: (nodeKey: string) => SignalsListBinding;
  // eslint-disable-next-line local/no-unknown-parameter-type
  literal: (value: unknown) => LiteralBinding;
};

/** `NodeInputCtx`, plus `item` — the current fan-out branch's own item. */
export type FanOutNodeInputCtx<TInput extends ZodType = ZodType> =
  NodeInputCtx<TInput> & {
    item: FanOutItemBinding;
  };

function makeBaseNodeInputCtx<TInput extends ZodType>(): NodeInputCtx<TInput> {
  return {
    pipelineInput: (path) => ({ source: "pipeline_input", path }),
    workItem: WORK_ITEM_ACCESSOR,
    signal: (nodeKey, signalKey) => ({
      source: "step_signal",
      nodeKey,
      signalKey,
    }),
    output: (nodeKey) => ({ source: "step_output", nodeKey }),
    signalsList: (nodeKey) => ({ source: "signals_list", nodeKey }),
    literal,
  };
}

export function makeNodeInputCtx<TInput extends ZodType>(): NodeInputCtx<TInput> {
  return makeBaseNodeInputCtx<TInput>();
}

export function makeFanOutNodeInputCtx<
  TInput extends ZodType,
>(): FanOutNodeInputCtx<TInput> {
  return {
    ...makeBaseNodeInputCtx<TInput>(),
    item: { source: "fan_out_item" },
  };
}
