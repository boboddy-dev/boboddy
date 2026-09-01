import { z, type ZodType } from "zod";
import type { StepDefinitionSpec } from "../steps/define-step";
import type {
  SerializedAdvancementPolicy,
  SerializedComputedSignalDefinition,
  SerializedCondition,
} from "../advancement-policies/define-advancement-policy";
import type {
  SerializedCohortAdvancementPolicy,
  SerializedStepSignalsListDefinition,
} from "../advancement-policies/cohort-advancement-policy";
import type { AnyTypedStep } from "./builder-helpers";
import type { SerializedBinding } from "./bindings";
import {
  assertNoIllegalConvergentEdges,
  compileChoiceState,
  compileFanOutState,
  compileLoopState,
  compileParallelState,
  compileStepState,
  compileTerminalState,
  type CompileContext,
} from "./compile-node-definitions";
import type { DefinePipelineInput } from "./pipeline-states";

export type {
  AdvancementPolicy,
  PipelineStepComputedSignalType,
} from "../advancement-policies/define-advancement-policy";
export {
  Computed,
  Rule,
} from "../advancement-policies/define-advancement-policy";
export * from "./pipeline-states";
export * from "./node-input-ctx";
export * from "./bindings";

// ─── Wire format ────────────────────────────────────────────────────────────

export type NodeDefinitionKind =
  | "step"
  | "fanOut"
  | "cohortGate"
  | "choice"
  | "parallel"
  | "loop"
  | "succeed"
  | "fail";

export type ChoiceCaseSpec = {
  conditionJson: SerializedCondition;
  targetNodeKey: string;
};

export type ParallelBranchSpec = {
  stepKey: string;
  stepName: string;
  stepDescription: string | null;
  inputBindingsJson: Record<string, SerializedBinding>;
};

/**
 * Fields shared by every node kind that does its own work by running a step
 * template (`step`/`fanOut`/`loop`) — the step's own key/name/description,
 * its resolved input bindings, and its timeout. Intersected into each of
 * those three kinds' own type below rather than duplicated field-for-field.
 */
type StepTemplateFields = {
  stepKey: string;
  stepName: string;
  stepDescription: string | null;
  inputBindingsJson: Record<string, SerializedBinding>;
  timeoutSeconds: number | null;
};

export type StepNodeDefinitionSpec = StepTemplateFields & {
  nodeKey: string;
  kind: "step";
  advancementPolicyDefinition: SerializedAdvancementPolicy;
  computedSignalDefinitions: SerializedComputedSignalDefinition[];
};

export type FanOutNodeDefinitionSpec = StepTemplateFields & {
  nodeKey: string;
  kind: "fanOut";
  /** The signal its branch cardinality is resolved from. */
  overSignalKey: string;
  /** Each branch's own continue/block decision. */
  advanceEachPolicyDefinition: SerializedCohortAdvancementPolicy;
  /** Caps how many branches release to the claim pool up front. */
  maxConcurrency: number | null;
};

export type CohortGateNodeDefinitionSpec = {
  nodeKey: string;
  kind: "cohortGate";
  /** The whole cohort's continue/block decision. */
  advanceAllPolicyDefinition: SerializedCohortAdvancementPolicy;
  /** Every `ctx.stepSignalsList`-derived value `advanceAll`'s rules may reference. */
  stepSignalsListDefinitions: SerializedStepSignalsListDefinition[];
};

export type ChoiceNodeDefinitionSpec = {
  nodeKey: string;
  kind: "choice";
  /** The routing table — may be empty when `default` alone covers every case. */
  choices: ChoiceCaseSpec[];
  /** The fallback target when no `choices[]` entry matches. */
  default: string | null;
};

export type ParallelNodeDefinitionSpec = {
  nodeKey: string;
  kind: "parallel";
  /** Its named, single-step branches. */
  branches: Record<string, ParallelBranchSpec>;
  /** The whole cohort's continue/block decision — absent means "continue iff every branch continued." */
  advanceAllPolicyDefinition?: SerializedCohortAdvancementPolicy;
};

export type LoopNodeDefinitionSpec = StepTemplateFields & {
  nodeKey: string;
  kind: "loop";
  maxIterations: number;
  /** The condition tested after each iteration. */
  untilConditionJson: SerializedCondition;
};

/** `succeed`/`fail` carry no fields of their own besides `nodeKey`/`kind`. */
export type TerminalNodeDefinitionSpec = {
  nodeKey: string;
  kind: "succeed" | "fail";
};

/**
 * One compiled node in the pipeline's graph, discriminated by `kind` — each
 * kind's own fields (see its type above) are the only ones legal on it; a
 * `choice` node has no `stepKey`, a `step` node has no `choices`, etc. The
 * ones that need real ids (a `step`/`fanOut`/`loop`'s `stepKey`, a
 * `parallel` branch's own `stepKey`) are resolved to `stepDefinitionId`s by
 * `pipeline-definitions-client.ts` at push time, not here — this spec only
 * ever carries author-declared keys.
 */
export type NodeDefinitionSpec =
  | StepNodeDefinitionSpec
  | FanOutNodeDefinitionSpec
  | CohortGateNodeDefinitionSpec
  | ChoiceNodeDefinitionSpec
  | ParallelNodeDefinitionSpec
  | LoopNodeDefinitionSpec
  | TerminalNodeDefinitionSpec;

/** The kinds that run a step template and therefore carry `StepTemplateFields`. */
export type WorkingNodeDefinitionSpec =
  StepNodeDefinitionSpec | FanOutNodeDefinitionSpec | LoopNodeDefinitionSpec;

/** Narrows a `NodeDefinitionSpec` to the kinds that run a step template. */
export function isWorkingNodeDefinition(
  node: NodeDefinitionSpec,
): node is WorkingNodeDefinitionSpec {
  return node.kind === "step" || node.kind === "fanOut" || node.kind === "loop";
}

export type DependencyEdgeSpec = {
  fromNodeKey: string;
  toNodeKey: string;
  /**
   * A `loop` node's `next`/`onExhausted` disambiguation
   * (`{loopExit: "next" | "onExhausted"}` — the routing source of truth
   * for `loop`) or a `choice` edge's designer-only display summary (never
   * the routing source of truth for `choice` — see §4).
   */
  discriminantJson?: Record<string, unknown> | null;
};

export type PipelineDefinitionSpec = {
  key: string;
  name: string;
  description: string | null;
  version: number;
  status: "draft" | "active" | "archived";
  inputSchemaJson?: Record<string, unknown> | null;
  nodeDefinitions: NodeDefinitionSpec[];
  dependencyEdges: DependencyEdgeSpec[];
  /** Step specs referenced by this pipeline. Used by the push command to auto-push steps that aren't explicitly exported. */
  _stepDefinitions?: StepDefinitionSpec[];
};

// ─── definePipeline() ────────────────────────────────────────────────────────

/**
 * Compiles a flat, ASL-flavored pipeline definition (see
 * docs/research/flat-pipeline-sdk-and-visual-designer.md §4) into the wire
 * `PipelineDefinitionSpec` shape. `states` is a map keyed by node key —
 * there is no `dependsOn`; every node's incoming edge(s) are derived here
 * by walking each state's own forward pointer(s) (`next`/`choices[].next`/
 * `default`/`onExhausted`/branch-completion target).
 */
export function definePipeline<TInput extends ZodType = z.ZodUnknown>(
  config: DefinePipelineInput<TInput>,
): PipelineDefinitionSpec {
  const stateEntries = Object.entries(config.states);
  if (stateEntries.length === 0) {
    throw new Error(`Pipeline "${config.key}" must declare at least one state`);
  }

  const startState = config.states[config.startAt];
  if (!startState) {
    throw new Error(
      `Pipeline "${config.key}"'s startAt "${config.startAt}" does not name a declared state`,
    );
  }
  if (
    startState.kind === "choice" ||
    startState.kind === "succeed" ||
    startState.kind === "fail"
  ) {
    throw new Error(
      `Pipeline "${config.key}"'s startAt "${config.startAt}" names a '${startState.kind}' state, which cannot be an entry point`,
    );
  }

  const stateKeys = new Set(Object.keys(config.states));
  const stepDefMap = new Map<string, StepDefinitionSpec>();
  const registerStep = (step: AnyTypedStep) => {
    const mapKey = `${step.key}@v${String(step.version)}`;
    if (!stepDefMap.has(mapKey)) stepDefMap.set(mapKey, step);
  };
  const compileContext: CompileContext = {
    pipelineKey: config.key,
    stateKeys,
    registerStep,
  };

  const nodeDefinitions: NodeDefinitionSpec[] = [];
  const dependencyEdges: DependencyEdgeSpec[] = [];

  for (const [stateKey, state] of stateEntries) {
    const compiled =
      state.kind === "step"
        ? compileStepState(stateKey, state, compileContext)
        : state.kind === "choice"
          ? compileChoiceState(stateKey, state, compileContext)
          : state.kind === "fanOut"
            ? compileFanOutState(stateKey, state, compileContext)
            : state.kind === "parallel"
              ? compileParallelState(stateKey, state, compileContext)
              : state.kind === "loop"
                ? compileLoopState(stateKey, state, compileContext)
                : compileTerminalState(stateKey, state.kind);

    nodeDefinitions.push(...compiled.nodeDefinitions);
    dependencyEdges.push(...compiled.edges);
  }

  const nodeKindByKey = new Map(
    nodeDefinitions.map((node) => [node.nodeKey, node.kind]),
  );
  assertNoIllegalConvergentEdges(config.key, nodeKindByKey, dependencyEdges);

  let inputSchemaJson: Record<string, unknown> | null = null;
  if (config.input) {
    try {
      inputSchemaJson = z.toJSONSchema(config.input);
    } catch {
      inputSchemaJson = null;
    }
  }

  return {
    key: config.key,
    name: config.name ?? config.key,
    description: config.description ?? null,
    version: config.version ?? 1,
    status: config.status ?? "active",
    inputSchemaJson,
    _stepDefinitions: [...stepDefMap.values()],
    nodeDefinitions,
    dependencyEdges,
  };
}
