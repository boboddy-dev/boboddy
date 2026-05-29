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

export type AnyBinding =
  | PipelineInputBinding
  | WorkItemBinding
  | StepSignalBinding
  | StepOutputBinding;

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

// ─── Output spec ──────────────────────────────────────────────────────────────

type SerializedBinding =
  | { source: "pipeline_input"; path: string }
  | { source: "work_item"; field: string }
  | { source: "step_signal"; stepKey: string; signalKey: string }
  | { source: "step_output"; stepKey: string };

export type PipelineDefinitionSpec = {
  key: string;
  name: string;
  description: string | null;
  version: number;
  status: "draft" | "active" | "archived";
  inputSchemaJson?: Record<string, unknown> | null;
  steps: Array<{
    stepKey: string;
    stepName: string;
    stepDescription: string | null;
    position: number;
    inputBindingsJson: Record<string, SerializedBinding>;
    timeoutSeconds: number | null;
    advancementPolicyDefinition: SerializedAdvancementPolicy;
    computedSignalDefinitions: SerializedComputedSignalDefinition[];
  }>;
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
  steps: ReadonlyArray<PipelineStepConfig>;
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
  return { source: "step_output", stepKey: binding.step.key };
}

export function buildPipelineSpec(
  config: DefinePipelineInput,
): PipelineDefinitionSpec {
  const steps = config.steps;
  const stepDefMap = new Map<string, StepDefinitionSpec>();
  for (const stepConfig of steps) {
    const mapKey = `${stepConfig.step.key}@v${String(stepConfig.step.version)}`;
    if (!stepDefMap.has(mapKey)) {
      stepDefMap.set(mapKey, stepConfig.step as StepDefinitionSpec);
    }
  }
  let inputSchemaJson: Record<string, unknown> | null = null;
  if (config.input) {
    try {
      inputSchemaJson = z.toJSONSchema(config.input) as Record<string, unknown>;
    } catch {
      inputSchemaJson = null;
    }
  }

  return {
    key: config.key,
    name: config.name,
    description: config.description ?? null,
    version: config.version ?? 1,
    status: config.status ?? "active",
    inputSchemaJson,
    _stepDefinitions: [...stepDefMap.values()],
    steps: steps.map((stepConfig, index) => {
      const autoBindings: Record<string, SerializedBinding> = {
        workItemTitle: { source: "work_item", field: "title" },
        workItemDescription: { source: "work_item", field: "description" },
      };

      const pipelineBindings: Record<string, SerializedBinding> = {};
      for (const [key, binding] of Object.entries(config.pipelineInputBindings ?? {})) {
        pipelineBindings[key] = serializeBinding(binding);
      }

      const explicitStepBindings = Object.fromEntries(
        Object.entries(stepConfig.input ?? {})
          .filter((entry): entry is [string, AnyBinding] => entry[1] !== undefined)
          .map(([key, binding]) => [key, serializeBinding(binding)]),
      );

      return ({
        stepKey: stepConfig.step.key,
        stepName: stepConfig.step.name,
        stepDescription: stepConfig.step.description,
        position: index + 1,
        inputBindingsJson: {
          ...autoBindings,
          ...pipelineBindings,
          ...explicitStepBindings,
        },
        timeoutSeconds: stepConfig.timeout ?? null,
        advancementPolicyDefinition: serializeAdvancementPolicy(
          stepConfig.advancement,
        ),
        computedSignalDefinitions: extractInlineComputedSignals(
          stepConfig.advancement,
        ),
      });
    }),
  };
}
