// Per-state-kind compilation: turns one authored `PipelineState` into its
// `NodeDefinitionSpec`(s) + `DependencyEdgeSpec`(s). Split out of
// `define-pipeline.ts` to keep that file under this repo's `max-lines` limit
// — `definePipeline()` itself is just "loop over states, dispatch by kind,
// concatenate the results, then run the whole-graph checks."

import {
  extractInlineComputedSignals,
  serializeAdvancementPolicy,
  serializeCondition,
  type AdvancementOutcome,
  type AdvancementPolicy,
  type Rule,
} from "../advancement-policies/define-advancement-policy";
import {
  extractInlineStepSignalsListDefinitions,
  serializeCohortAdvancementPolicy,
  type CohortAdvancementPolicy,
  type SerializedCohortAdvancementPolicy,
} from "../advancement-policies/cohort-advancement-policy";
import { makeAdvanceAllCtx, makeAdvanceEachCtx } from "../advancement-policies/cohort-fluent-rules";
import type { AnyTypedStep } from "./builder-helpers";
import { serializeInputBindings } from "./bindings";
import type {
  DependencyEdgeSpec,
  NodeDefinitionSpec,
  ParallelBranchSpec,
} from "./define-pipeline";
import { makeFanOutNodeInputCtx, makeNodeInputCtx } from "./node-input-ctx";
import type {
  ChoiceState,
  FanOutState,
  LoopState,
  ParallelState,
  StepState,
} from "./pipeline-states";

export type CompileContext = {
  pipelineKey: string;
  stateKeys: ReadonlySet<string>;
  registerStep: (step: AnyTypedStep) => void;
};

export type CompiledState = {
  nodeDefinitions: NodeDefinitionSpec[];
  edges: DependencyEdgeSpec[];
};

export function assertTargetExists(
  ctx: CompileContext,
  fromKey: string,
  toKey: string,
): void {
  if (!ctx.stateKeys.has(toKey)) {
    throw new Error(
      `Pipeline "${ctx.pipelineKey}": state "${fromKey}" targets unknown state "${toKey}"`,
    );
  }
}

/** The signal key portion of a `fanOut.over` value — strips an optional `"stateKey."` display prefix. */
function overSignalKeyOf(over: string): string {
  const lastDot = over.lastIndexOf(".");
  return lastDot === -1 ? over : over.slice(lastDot + 1);
}

export function compileStepState(
  stateKey: string,
  state: StepState,
  ctx: CompileContext,
): CompiledState {
  ctx.registerStep(state.step);
  const inputCtx = makeNodeInputCtx();
  const rawInput = state.input ? state.input(inputCtx) : {};
  const inputBindingsJson = serializeInputBindings(rawInput);

  const routeTarget = typeof state.next === "object" ? state.next : null;
  const defaultOutcome: AdvancementOutcome = routeTarget
    ? {
        outcome: "route",
        pipelineKey: routeTarget.routeToPipeline,
        ...(routeTarget.input ? { inputJson: routeTarget.input } : {}),
      }
    : "continue";
  const rules: Rule[] = state.blockWhen
    ? [{ _tag: "rule", mode: "all", conditions: [state.blockWhen], outcome: "block" }]
    : [];
  const policy: AdvancementPolicy = { defaultOutcome, rules };

  const nodeDefinitions: NodeDefinitionSpec[] = [
    {
      nodeKey: stateKey,
      kind: "step",
      stepKey: state.step.key,
      stepName: state.step.name,
      stepDescription: state.step.description,
      inputBindingsJson,
      timeoutSeconds: state.timeout ?? null,
      advancementPolicyDefinition: serializeAdvancementPolicy(policy),
      computedSignalDefinitions: extractInlineComputedSignals(policy),
    },
  ];

  const edges: DependencyEdgeSpec[] = [];
  if (!routeTarget) {
    const nextKey = state.next as string;
    assertTargetExists(ctx, stateKey, nextKey);
    edges.push({ fromNodeKey: stateKey, toNodeKey: nextKey });
  }

  return { nodeDefinitions, edges };
}

export function compileChoiceState(
  stateKey: string,
  state: ChoiceState,
  ctx: CompileContext,
): CompiledState {
  const stateChoices = state.choices ?? [];
  if (stateChoices.length === 0 && !state.default) {
    throw new Error(
      `Pipeline "${ctx.pipelineKey}": choice state "${stateKey}" requires at least one entry in choices or a default target`,
    );
  }

  const choices = stateChoices.map((choiceCase) => {
    assertTargetExists(ctx, stateKey, choiceCase.next);
    return {
      conditionJson: serializeCondition(choiceCase.when),
      targetNodeKey: choiceCase.next,
    };
  });
  if (state.default) assertTargetExists(ctx, stateKey, state.default);

  const edges: DependencyEdgeSpec[] = stateChoices.map((choiceCase) => ({
    fromNodeKey: stateKey,
    toNodeKey: choiceCase.next,
    discriminantJson: { conditionSummary: serializeCondition(choiceCase.when) },
  }));
  if (state.default) {
    edges.push({
      fromNodeKey: stateKey,
      toNodeKey: state.default,
      discriminantJson: { default: true },
    });
  }

  return {
    nodeDefinitions: [
      { nodeKey: stateKey, kind: "choice", choices, default: state.default ?? null },
    ],
    edges,
  };
}

export function compileFanOutState(
  stateKey: string,
  state: FanOutState,
  ctx: CompileContext,
): CompiledState {
  ctx.registerStep(state.step);
  const inputCtx = makeFanOutNodeInputCtx();
  const rawInput = state.input ? state.input(inputCtx) : {};
  const inputBindingsJson = serializeInputBindings(rawInput);

  const advanceEachResult = state.advanceEach(makeAdvanceEachCtx<string>());
  const advanceEachPolicy: CohortAdvancementPolicy = {
    default: advanceEachResult.default,
    ...(advanceEachResult.rules !== undefined ? { rules: advanceEachResult.rules } : {}),
  };

  const advanceAllResult = state.advanceAll(makeAdvanceAllCtx());
  const advanceAllPolicy: CohortAdvancementPolicy = {
    default: advanceAllResult.default,
    ...(advanceAllResult.rules !== undefined ? { rules: advanceAllResult.rules } : {}),
  };

  const gateKey = `${stateKey}__cohortGate`;
  if (ctx.stateKeys.has(gateKey)) {
    throw new Error(
      `Pipeline "${ctx.pipelineKey}": synthesized cohortGate key "${gateKey}" collides with an author-declared state — rename state "${stateKey}"`,
    );
  }

  assertTargetExists(ctx, stateKey, state.next);

  return {
    nodeDefinitions: [
      {
        nodeKey: stateKey,
        kind: "fanOut",
        stepKey: state.step.key,
        stepName: state.step.name,
        stepDescription: state.step.description,
        inputBindingsJson,
        timeoutSeconds: state.timeout ?? null,
        overSignalKey: overSignalKeyOf(state.over),
        advanceEachPolicyDefinition: serializeCohortAdvancementPolicy(advanceEachPolicy),
        maxConcurrency: state.maxConcurrency ?? null,
      },
      {
        nodeKey: gateKey,
        kind: "cohortGate",
        advanceAllPolicyDefinition: serializeCohortAdvancementPolicy(advanceAllPolicy),
        stepSignalsListDefinitions: extractInlineStepSignalsListDefinitions(advanceAllPolicy),
      },
    ],
    edges: [
      { fromNodeKey: stateKey, toNodeKey: gateKey },
      { fromNodeKey: gateKey, toNodeKey: state.next },
    ],
  };
}

export function compileParallelState(
  stateKey: string,
  state: ParallelState,
  ctx: CompileContext,
): CompiledState {
  const branchEntries = Object.entries(state.branches);
  if (branchEntries.length === 0) {
    throw new Error(
      `Pipeline "${ctx.pipelineKey}": parallel state "${stateKey}" requires at least one branch`,
    );
  }

  const branches: Record<string, ParallelBranchSpec> = {};
  for (const [branchKey, branchConfig] of branchEntries) {
    ctx.registerStep(branchConfig.step);
    const inputCtx = makeNodeInputCtx();
    const rawInput = branchConfig.input ? branchConfig.input(inputCtx) : {};
    branches[branchKey] = {
      stepKey: branchConfig.step.key,
      stepName: branchConfig.step.name,
      stepDescription: branchConfig.step.description,
      inputBindingsJson: serializeInputBindings(rawInput),
    };
  }

  let advanceAllPolicyDefinition: SerializedCohortAdvancementPolicy | undefined;
  if (state.advanceAll) {
    const advanceAllResult = state.advanceAll(makeAdvanceAllCtx());
    const advanceAllPolicy: CohortAdvancementPolicy = {
      default: advanceAllResult.default,
      ...(advanceAllResult.rules !== undefined ? { rules: advanceAllResult.rules } : {}),
    };
    advanceAllPolicyDefinition = serializeCohortAdvancementPolicy(advanceAllPolicy);
  }

  assertTargetExists(ctx, stateKey, state.next);

  return {
    nodeDefinitions: [
      {
        nodeKey: stateKey,
        kind: "parallel",
        branches,
        ...(advanceAllPolicyDefinition ? { advanceAllPolicyDefinition } : {}),
      },
    ],
    edges: [{ fromNodeKey: stateKey, toNodeKey: state.next }],
  };
}

export function compileLoopState(
  stateKey: string,
  state: LoopState,
  ctx: CompileContext,
): CompiledState {
  ctx.registerStep(state.step);
  const inputCtx = makeNodeInputCtx();
  const rawInput = state.input ? state.input(inputCtx) : {};

  assertTargetExists(ctx, stateKey, state.next);
  assertTargetExists(ctx, stateKey, state.onExhausted);

  return {
    nodeDefinitions: [
      {
        nodeKey: stateKey,
        kind: "loop",
        stepKey: state.step.key,
        stepName: state.step.name,
        stepDescription: state.step.description,
        inputBindingsJson: serializeInputBindings(rawInput),
        timeoutSeconds: state.timeout ?? null,
        maxIterations: state.maxIterations,
        untilConditionJson: serializeCondition(state.until),
      },
    ],
    edges: [
      { fromNodeKey: stateKey, toNodeKey: state.next, discriminantJson: { loopExit: "next" } },
      {
        fromNodeKey: stateKey,
        toNodeKey: state.onExhausted,
        discriminantJson: { loopExit: "onExhausted" },
      },
    ],
  };
}

export function compileTerminalState(
  stateKey: string,
  kind: "succeed" | "fail",
): CompiledState {
  return { nodeDefinitions: [{ nodeKey: stateKey, kind }], edges: [] };
}

/**
 * The SDK-side mirror of §6's domain invariant: a node may have more than
 * one incoming edge only when every source is a `choice`/`loop` state
 * (never an unconditional `step`/`fanOut`/`parallel`/`cohortGate`
 * successor) — gives authors a fast local error instead of a round-trip to
 * the server.
 */
export function assertNoIllegalConvergentEdges(
  pipelineKey: string,
  nodeKindByKey: ReadonlyMap<string, NodeDefinitionSpec["kind"]>,
  edges: readonly DependencyEdgeSpec[],
): void {
  const incoming = new Map<string, DependencyEdgeSpec[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.toNodeKey) ?? [];
    list.push(edge);
    incoming.set(edge.toNodeKey, list);
  }

  for (const [targetKey, incomingEdges] of incoming) {
    if (incomingEdges.length <= 1) continue;
    const hasInvalidSource = incomingEdges.some((edge) => {
      const kind = nodeKindByKey.get(edge.fromNodeKey);
      return kind !== "choice" && kind !== "loop";
    });
    if (hasInvalidSource) {
      throw new Error(
        `Pipeline "${pipelineKey}": state "${targetKey}" has more than one incoming edge, but not every source is a 'choice'/'loop' state (unconditional convergent edges are not allowed — see docs/research/flat-pipeline-sdk-and-visual-designer.md §6).`,
      );
    }
  }
}
