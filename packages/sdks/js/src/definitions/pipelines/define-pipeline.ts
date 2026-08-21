import { z, type ZodType } from "zod";
import type {
  StepDefinitionSpec,
  TypedStepDefinitionSpec,
} from "../steps/define-step";
import {
  type AdvancementPolicy,
  extractInlineComputedSignals,
  serializeAdvancementPolicy,
  type SerializedAdvancementPolicy,
  type SerializedComputedSignalDefinition,
} from "../advancement-policies/define-advancement-policy";
import {
  type CohortAdvancementPolicy,
  extractInlineStepSignalsListDefinitions,
  serializeCohortAdvancementPolicy,
  type SerializedCohortAdvancementPolicy,
  type SerializedStepSignalsListDefinition,
} from "../advancement-policies/cohort-advancement-policy";
import { buildChainDependencyEdges } from "./chain-graph";

export type {
  AdvancementPolicy,
  PipelineStepComputedSignalType,
} from "../advancement-policies/define-advancement-policy";
export {
  Computed,
  Rule,
} from "../advancement-policies/define-advancement-policy";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTypedStep = TypedStepDefinitionSpec<any, any, any, any>;

// ─── Input binding types ──────────────────────────────────────────────────────

export type PipelineInputBinding = {
  source: "pipeline_input";
  path: string;
};

export type WorkItemBinding = {
  source: "work_item";
  field: string;
};

export type StepSignalBinding = {
  source: "step_signal";
  step: AnyTypedStep;
  signalKey: string;
};

export type StepOutputBinding = {
  source: "step_output";
  step: AnyTypedStep;
};

export type LiteralBinding = {
  source: "literal";
  value: unknown;
};

/**
 * `ctx.signalsList(fanOutStep)`'s binding (issue #167): reaches a fan-out's
 * whole cohort — every terminal branch's own signals + output — from a
 * later, non-adjacent step's input mapper. Resolved server-side against
 * `ResolvedNodeInputContext.cohorts[stepKey]` (an array of
 * `{ branchIndex, signals, outputJson }`, sorted by `branchIndex`).
 */
export type SignalsListBinding = {
  source: "signals_list";
  fanOutStep: AnyTypedStep;
};

/**
 * `.fanOutStep(step, config)`'s own `input` ctx's `item` binding (issue
 * #167): resolves server-side, per branch, to that branch's own item value
 * — the element of the array `config.over` names, when `over` resolves to
 * an array (count-only mode has no `item` to bind, both at the type level
 * — see `FanOutItemType` — and at the wire level, since no `fanOut` node
 * config would carry an `item` binding for it). Carries no extra fields:
 * the branch index alone (implicit in which branch is executing) is enough
 * to resolve the right element server-side.
 */
export type FanOutItemBinding = {
  source: "fan_out_item";
};

export type AnyBinding =
  | PipelineInputBinding
  | WorkItemBinding
  | StepSignalBinding
  | StepOutputBinding
  | LiteralBinding
  | SignalsListBinding
  | FanOutItemBinding;

// ─── Pipeline step config ─────────────────────────────────────────────────────

export type PipelineStepConfig<TStep extends AnyTypedStep = AnyTypedStep> = {
  step: TStep;
  /** Maps each step input field to an input source. Extra keys are ignored at runtime. */
  input?: Partial<{
    [K in keyof NonNullable<TStep["__inputType"]> & string]: AnyBinding;
  }>;
  timeout?: number | null;
  /**
   * Controls when and how this step advances in the pipeline.
   * Signal keys in `Rule.signal()` / `Rule.when()` calls are type-checked
   * against the step's declared signals. Inline `Computed.X(...)` tokens can
   * also appear in the signal position; they're hoisted into the step's
   * `computedSignalDefinitions` at serialization time.
   * Defaults to `{ defaultOutcome: "continue" }` when omitted.
   */
  advancement?: AdvancementPolicy<TStep["__signalKeys"]>;
};

/**
 * `.fanOutStep(step, config)`'s node config (issue #167): a `fanOut` node
 * whose `stepDefinitionId`/`stepDefinitionVersion` template is `fanOutStep`
 * — the template every branch executes — and whose `advanceEach` policy
 * each branch's own result is evaluated against. Pushes exactly one
 * `fanOut` node onto the pipeline's node sequence (paired with exactly one
 * `PipelineCohortGateNodeConfig` immediately after it — see `.advanceAll()`
 * — never more than the fan-out+gate pair itself).
 *
 * Named `*StepConfig` (rather than a bare `PipelineFanOutConfig`) to reserve
 * room for a future sibling `PipelineFanOutSubPipelineConfig` — a fan-out
 * whose template is a whole sub-pipeline rather than a single step. That
 * sibling is out of scope for issue #167 and is not implemented here.
 */
export type PipelineFanOutStepConfig<
  TStep extends AnyTypedStep = AnyTypedStep,
> = {
  nodeType: "fanOut";
  fanOutStep: TStep;
  overSignalKey: string;
  input?: Partial<{
    [K in keyof NonNullable<TStep["__inputType"]> & string]: AnyBinding;
  }>;
  timeout?: number | null;
  advanceEach?: CohortAdvancementPolicy;
};

/**
 * `.advanceAll(callback)`'s node config (issue #167): the pure decision
 * gate that aggregates a fan-out's cohort back together — no work of its
 * own, so no `step`/`input`/`timeout`. `nodeKey` is derived by the builder
 * (`${fanOutStep.key}__cohortGate`), not user-supplied.
 */
export type PipelineCohortGateNodeConfig = {
  nodeType: "cohortGate";
  nodeKey: string;
  advanceAll?: CohortAdvancementPolicy;
  stepSignalsListDefinitions?: SerializedStepSignalsListDefinition[];
};

/**
 * A single entry in a pipeline's declaration-order node sequence: an
 * ordinary step, or one half of a fan-out+cohort-gate pair. Discriminated
 * by the presence/value of `nodeType` (absent means a plain step) rather
 * than a `kind` field, so `PipelineStepConfig` itself needs no change.
 */
export type PipelineNodeConfig =
  PipelineStepConfig | PipelineFanOutStepConfig | PipelineCohortGateNodeConfig;

// ─── Output spec ──────────────────────────────────────────────────────────────

export type SerializedBinding =
  | { source: "pipeline_input"; path: string }
  | { source: "work_item"; field: string }
  | { source: "step_signal"; stepKey: string; signalKey: string }
  | { source: "step_output"; stepKey: string }
  | { source: "literal"; value: unknown }
  | { source: "signals_list"; stepKey: string }
  | { source: "fan_out_item" };

export type NodeDefinitionKind = "step" | "fanOut" | "cohortGate";

export type NodeDefinitionSpec = {
  /** Unique within the pipeline; equals `stepKey` for a step/fanOut node, or the builder-derived gate key for a cohortGate node. */
  nodeKey: string;
  kind: NodeDefinitionKind;
  /** `step`/`fanOut` only — the step template's key/version. Absent on a `cohortGate` node (it produces no work of its own). */
  stepKey?: string;
  stepName?: string;
  stepDescription?: string | null;
  inputBindingsJson?: Record<string, SerializedBinding>;
  timeoutSeconds?: number | null;
  /** `step` only. */
  advancementPolicyDefinition?: SerializedAdvancementPolicy;
  /** `step` only. */
  computedSignalDefinitions?: SerializedComputedSignalDefinition[];
  /** `fanOut` only — the signal its branch cardinality is resolved from. */
  overSignalKey?: string;
  /** `fanOut` only — each branch's own continue/block decision. */
  advanceEachPolicyDefinition?: SerializedCohortAdvancementPolicy;
  /** `cohortGate` only — the whole cohort's continue/block decision. */
  advanceAllPolicyDefinition?: SerializedCohortAdvancementPolicy;
  /** `cohortGate` only — every `ctx.stepSignalsList`-derived value `advanceAll`'s rules may reference. */
  stepSignalsListDefinitions?: SerializedStepSignalsListDefinition[];
};

export type DependencyEdgeSpec = {
  fromNodeKey: string;
  toNodeKey: string;
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

export type DefinePipelineInput = {
  key: string;
  name: string;
  description?: string | null;
  version?: number;
  status?: "draft" | "active";
  input?: ZodType | null;
  nodes: ReadonlyArray<PipelineNodeConfig>;
  pipelineInputBindings?: Record<string, AnyBinding>;
};

function serializeBinding(binding: AnyBinding): SerializedBinding {
  if (binding.source === "pipeline_input") {
    return { source: "pipeline_input", path: binding.path };
  }
  if (binding.source === "work_item") {
    return { source: "work_item", field: binding.field };
  }
  if (binding.source === "step_signal") {
    return {
      source: "step_signal",
      stepKey: binding.step.key,
      signalKey: binding.signalKey,
    };
  }
  if (binding.source === "literal") {
    return { source: "literal", value: binding.value };
  }
  if (binding.source === "signals_list") {
    return { source: "signals_list", stepKey: binding.fanOutStep.key };
  }
  if (binding.source === "fan_out_item") {
    return { source: "fan_out_item" };
  }
  return { source: "step_output", stepKey: binding.step.key };
}

/** A node config carries a discriminating `nodeType` iff it isn't a plain step. */
const isFanOutConfig = (
  node: PipelineNodeConfig,
): node is PipelineFanOutStepConfig =>
  "nodeType" in node && node.nodeType === "fanOut";

const isCohortGateConfig = (
  node: PipelineNodeConfig,
): node is PipelineCohortGateNodeConfig =>
  "nodeType" in node && node.nodeType === "cohortGate";

function serializeInputBindings(
  input: Partial<Record<string, AnyBinding>> | undefined,
  pipelineInputBindings: Record<string, AnyBinding> | undefined,
): Record<string, SerializedBinding> {
  const autoBindings: Record<string, SerializedBinding> = {
    workItemTitle: { source: "work_item", field: "title" },
    workItemDescription: { source: "work_item", field: "description" },
  };

  const pipelineBindings: Record<string, SerializedBinding> = {};
  for (const [key, binding] of Object.entries(pipelineInputBindings ?? {})) {
    pipelineBindings[key] = serializeBinding(binding);
  }

  const explicitBindings = Object.fromEntries(
    Object.entries(input ?? {})
      .filter((entry): entry is [string, AnyBinding] => entry[1] !== undefined)
      .map(([key, binding]) => [key, serializeBinding(binding)]),
  );

  return { ...autoBindings, ...pipelineBindings, ...explicitBindings };
}

export function buildPipelineSpec(
  config: DefinePipelineInput,
): PipelineDefinitionSpec {
  const nodes = config.nodes;
  const stepDefMap = new Map<string, StepDefinitionSpec>();
  const registerStepDef = (step: AnyTypedStep) => {
    const mapKey = `${step.key}@v${String(step.version)}`;
    if (!stepDefMap.has(mapKey)) {
      stepDefMap.set(mapKey, step);
    }
  };
  for (const node of nodes) {
    if (isFanOutConfig(node)) {
      registerStepDef(node.fanOutStep);
    } else if (!isCohortGateConfig(node)) {
      registerStepDef(node.step);
    }
  }

  let inputSchemaJson: Record<string, unknown> | null = null;
  if (config.input) {
    try {
      inputSchemaJson = z.toJSONSchema(config.input);
    } catch {
      inputSchemaJson = null;
    }
  }

  const nodeDefinitions: NodeDefinitionSpec[] = nodes.map((node) => {
    if (isCohortGateConfig(node)) {
      const serializedPolicy = serializeCohortAdvancementPolicy(
        node.advanceAll,
      );
      const inlineStepSignalsListDefinitions =
        extractInlineStepSignalsListDefinitions(node.advanceAll);
      return {
        nodeKey: node.nodeKey,
        kind: "cohortGate",
        advanceAllPolicyDefinition: serializedPolicy,
        stepSignalsListDefinitions: [
          ...inlineStepSignalsListDefinitions,
          ...(node.stepSignalsListDefinitions ?? []),
        ],
      };
    }

    if (isFanOutConfig(node)) {
      return {
        nodeKey: node.fanOutStep.key,
        kind: "fanOut",
        stepKey: node.fanOutStep.key,
        stepName: node.fanOutStep.name,
        stepDescription: node.fanOutStep.description,
        inputBindingsJson: serializeInputBindings(
          node.input,
          config.pipelineInputBindings,
        ),
        timeoutSeconds: node.timeout ?? null,
        overSignalKey: node.overSignalKey,
        advanceEachPolicyDefinition: serializeCohortAdvancementPolicy(
          node.advanceEach,
        ),
      };
    }

    return {
      nodeKey: node.step.key,
      kind: "step",
      stepKey: node.step.key,
      stepName: node.step.name,
      stepDescription: node.step.description,
      inputBindingsJson: serializeInputBindings(
        node.input,
        config.pipelineInputBindings,
      ),
      timeoutSeconds: node.timeout ?? null,
      advancementPolicyDefinition: serializeAdvancementPolicy(node.advancement),
      computedSignalDefinitions: extractInlineComputedSignals(node.advancement),
    };
  });

  const dependencyEdges: DependencyEdgeSpec[] =
    buildChainDependencyEdges(nodeDefinitions);

  return {
    key: config.key,
    name: config.name,
    description: config.description ?? null,
    version: config.version ?? 1,
    status: config.status ?? "active",
    inputSchemaJson,
    _stepDefinitions: [...stepDefMap.values()],
    nodeDefinitions,
    dependencyEdges,
  };
}
