// Spec builders shared by the `validateDefinitionSpecs` suites.
//
// The specs are hand-built rather than produced by `defineStep` / `pipeline()`
// on purpose: most of these fixtures are exactly the mistakes the builders (and,
// since the `SignalSpecInput` fix, the type system) refuse to make. The point of
// the runtime validator is the callers that bypass them — JS files, generated
// files, hand-edited files — so the tests have to bypass them too.

import { z } from "zod";
import { buildChainDependencyEdges } from "../src/definitions/pipelines/chain-graph";
import type { PipelineDefinitionSpec } from "../src/definitions/pipelines";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import { validateDefinitionSpecs } from "../src/definitions/validation";

export type PipelineStep = PipelineDefinitionSpec["nodeDefinitions"][number] & {
  /**
   * Fixture-only ordinal: how tests express "this step really runs Nth"
   * independent of array-literal order. Stripped before being placed into
   * `nodeDefinitions` — `pipelineSpec()` sorts by it and synthesizes
   * `dependencyEdges` from the sorted order instead.
   */
  __order: number;
};
export type Bindings = PipelineStep["inputBindingsJson"];

export function stepSpec(
  key: string,
  result: z.ZodType | null,
  sourcePaths: readonly string[],
): StepDefinitionSpec {
  return {
    key,
    name: key,
    description: null,
    version: 1,
    kind: "user_defined",
    status: "active",
    prompt: null,
    inputSchemaJson: null,
    resultSchemaJson: result ? z.toJSONSchema(result) : null,
    signalExtractorDefinitions: sourcePaths.map((sourcePath) => ({
      key: sourcePath,
      sourcePath,
      type: "string",
      required: true,
      availableWhenResultStatusIn: null,
    })),
    opencodeMcpJson: null,
    opencodePluginJson: null,
    healthChecksJson: null,
  };
}

/** `stepSpec`, but with arbitrary field overrides (e.g. mcpServers, healthChecks). */
export function stepSpecWithOverrides(
  key: string,
  overrides: Partial<StepDefinitionSpec> = {},
): StepDefinitionSpec {
  return { ...stepSpec(key, null, []), ...overrides };
}

export function pipelineStep(
  stepKey: string,
  order: number,
  overrides: Partial<PipelineStep> = {},
): PipelineStep {
  return {
    nodeKey: stepKey,
    kind: "step",
    stepKey,
    stepName: stepKey,
    stepDescription: null,
    __order: order,
    inputBindingsJson: {},
    timeoutSeconds: null,
    advancementPolicyDefinition: {
      rulesJson: { rules: [] },
      defaultEventType: "continue",
      defaultEventParamsJson: null,
      allowedEventTypes: ["continue"],
    },
    computedSignalDefinitions: [],
    ...overrides,
  };
}

export function pipelineSpec(
  key: string,
  steps: readonly PipelineStep[],
): PipelineDefinitionSpec {
  const sorted = [...steps].sort((left, right) => left.__order - right.__order);
  const nodeDefinitions = sorted.map((step) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { __order, ...node } = step;
    return node;
  });
  const dependencyEdges = buildChainDependencyEdges(nodeDefinitions);

  return {
    key,
    name: key,
    description: null,
    version: 1,
    status: "active",
    nodeDefinitions,
    dependencyEdges,
  };
}

/** Messages produced by validating one step in isolation. */
export function sourcePathIssues(
  result: z.ZodType | null,
  sourcePaths: readonly string[],
): string[] {
  return validateDefinitionSpecs({
    pipelines: [],
    steps: [stepSpec("s", result, sourcePaths)],
  }).map((issue) => issue.message);
}
