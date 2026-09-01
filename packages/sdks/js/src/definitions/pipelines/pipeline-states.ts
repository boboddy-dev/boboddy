import type { ZodType } from "zod";
import type { RuleCondition } from "../advancement-policies/define-advancement-policy";
import type {
  AdvanceAllCtx,
  AdvanceAllResult,
  AdvanceEachCtx,
  AdvanceEachResult,
} from "../advancement-policies/cohort-fluent-rules";
import type { AnyTypedStep } from "./builder-helpers";
import type { AnyBinding } from "./bindings";
import type { FanOutNodeInputCtx, NodeInputCtx } from "./node-input-ctx";

/**
 * The 7 authoring state kinds (see
 * docs/research/flat-pipeline-sdk-and-visual-designer.md §4/§5). Every
 * kind besides `choice`/`succeed`/`fail` does its own work (a `step`) and
 * therefore declares exactly one authored `input`/`timeout`; `choice` and
 * `loop` are the only kinds with more than one possible exit.
 */

/** `next: "otherStateKey"`, or a special cross-pipeline route target. */
export type NextTarget =
  | string
  | { routeToPipeline: string; input?: Record<string, unknown> | null };

export type StepState = {
  kind: "step";
  step: AnyTypedStep;
  input?: (ctx: NodeInputCtx) => Partial<Record<string, AnyBinding>>;
  timeout?: number | null;
  /**
   * A single-condition "pause for human review" gate — the narrow
   * replacement for the old per-step rules-engine policy object (see §5's
   * `complete`/`route`/`block` migration notes). When the condition
   * matches, the node run blocks instead of advancing to `next`.
   */
  blockWhen?: RuleCondition;
  next: NextTarget;
};

export type ChoiceCase = { when: RuleCondition; next: string };

export type ChoiceState = {
  kind: "choice";
  /** At least one of `choices`/`default` is required — see `compileChoiceState`. */
  choices?: ReadonlyArray<ChoiceCase>;
  default?: string | null;
};

export type FanOutState = {
  kind: "fanOut";
  step: AnyTypedStep;
  /**
   * The signal to resolve branch cardinality (and, in array mode, each
   * branch's own item) from. A bare signal key (`"changedFiles"`) or a
   * `"stateKey.signalKey"` dotted convenience form — the dotted prefix is
   * author-facing documentation only; the runtime resolves the signal by
   * scanning every upstream node's own signals for a matching key (see
   * `resolveFanOutCardinality`), not by an explicit node reference.
   */
  over: string;
  maxConcurrency?: number | null;
  input?: (ctx: FanOutNodeInputCtx) => Partial<Record<string, AnyBinding>>;
  timeout?: number | null;
  advanceEach: (ctx: AdvanceEachCtx) => AdvanceEachResult;
  advanceAll: (ctx: AdvanceAllCtx) => AdvanceAllResult;
  next: string;
};

export type ParallelBranchConfig = {
  step: AnyTypedStep;
  input?: (ctx: NodeInputCtx) => Partial<Record<string, AnyBinding>>;
  timeout?: number | null;
};

export type ParallelState = {
  kind: "parallel";
  /** Named branches (v1: single-step only — see decision 5). */
  branches: Record<string, ParallelBranchConfig>;
  /** Defaults to "continue iff every branch continued" when omitted. */
  advanceAll?: (ctx: AdvanceAllCtx) => AdvanceAllResult;
  next: string;
};

export type LoopState = {
  kind: "loop";
  step: AnyTypedStep;
  maxIterations: number;
  input?: (ctx: NodeInputCtx) => Partial<Record<string, AnyBinding>>;
  timeout?: number | null;
  until: RuleCondition;
  next: string;
  onExhausted: string;
};

export type SucceedState = { kind: "succeed" };
export type FailState = { kind: "fail" };

export type PipelineState =
  | StepState
  | ChoiceState
  | FanOutState
  | ParallelState
  | LoopState
  | SucceedState
  | FailState;

export type DefinePipelineInput<TInput extends ZodType = ZodType> = {
  key: string;
  name?: string;
  description?: string | null;
  version?: number;
  status?: "draft" | "active";
  /** The pipeline's own input schema — drives `ctx.pipelineInput(path)`'s typing and `inputSchemaJson`. */
  input?: TInput;
  /** The entry state's key. Must not name a `choice`/`succeed`/`fail` state. */
  startAt: string;
  /** Every state in the pipeline, keyed by its unique node key. */
  states: Record<string, PipelineState>;
};
