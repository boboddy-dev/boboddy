// Input-binding types + serialization, shared by `node-input-ctx.ts`,
// `pipeline-states.ts`, `compile-node-definitions.ts`, and `define-pipeline.ts`
// (which re-exports the author-facing pieces for backward-compatible
// imports off `./define-pipeline`). Split into its own module so those
// files can depend on bindings without a circular import through
// `define-pipeline.ts` itself.

export type PipelineInputBinding = { source: "pipeline_input"; path: string };
export type WorkItemBinding = { source: "work_item"; field: string };

/** Reads a signal declared by an earlier node, addressed by its state key. */
export type StepSignalBinding = {
  source: "step_signal";
  nodeKey: string;
  signalKey: string;
};

/** Reads an earlier node's whole result output, addressed by its state key. */
export type StepOutputBinding = { source: "step_output"; nodeKey: string };

export type LiteralBinding = { source: "literal"; value: unknown };

/** Reaches a fan-out's whole cohort (every terminal branch's signals + output). */
export type SignalsListBinding = { source: "signals_list"; nodeKey: string };

/** A fan-out's own per-branch item — see `FanOutNodeInputCtx`. */
export type FanOutItemBinding = { source: "fan_out_item" };

export type AnyBinding =
  | PipelineInputBinding
  | WorkItemBinding
  | StepSignalBinding
  | StepOutputBinding
  | LiteralBinding
  | SignalsListBinding
  | FanOutItemBinding;

export type SerializedBinding =
  | { source: "pipeline_input"; path: string }
  | { source: "work_item"; field: string }
  | { source: "step_signal"; stepKey: string; signalKey: string }
  | { source: "step_output"; stepKey: string }
  | { source: "literal"; value: unknown }
  | { source: "signals_list"; stepKey: string }
  | { source: "fan_out_item" };

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
      stepKey: binding.nodeKey,
      signalKey: binding.signalKey,
    };
  }
  if (binding.source === "literal") {
    return { source: "literal", value: binding.value };
  }
  if (binding.source === "signals_list") {
    return { source: "signals_list", stepKey: binding.nodeKey };
  }
  if (binding.source === "fan_out_item") {
    return { source: "fan_out_item" };
  }
  return { source: "step_output", stepKey: binding.nodeKey };
}

/**
 * Builds the wire `inputBindingsJson` for any working node: `workItemTitle`/
 * `workItemDescription` are always auto-bound (mirroring the retired
 * builder's own behavior), then overridden/extended by whatever the
 * author's `input` mapper returned.
 */
export function serializeInputBindings(
  input: Partial<Record<string, AnyBinding | undefined>>,
): Record<string, SerializedBinding> {
  const autoBindings: Record<string, SerializedBinding> = {
    workItemTitle: { source: "work_item", field: "title" },
    workItemDescription: { source: "work_item", field: "description" },
  };

  const explicitBindings = Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, AnyBinding] => entry[1] !== undefined)
      .map(([key, binding]) => [key, serializeBinding(binding)]),
  );

  return { ...autoBindings, ...explicitBindings };
}
