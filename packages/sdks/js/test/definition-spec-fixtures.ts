// Spec builders shared by the `validateDefinitionSpecs` suites.
//
// The specs are hand-built rather than produced by `defineStep` / `pipeline()`
// on purpose: most of these fixtures are exactly the mistakes the builders (and,
// since the `SignalSpecInput` fix, the type system) refuse to make. The point of
// the runtime validator is the callers that bypass them — JS files, generated
// files, hand-edited files — so the tests have to bypass them too.

import { z } from "zod";
import type { PipelineDefinitionSpec } from "../src/definitions/pipelines";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import { validateDefinitionSpecs } from "../src/definitions/validation";

export type PipelineStep = PipelineDefinitionSpec["steps"][number];
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
  position: number,
  overrides: Partial<PipelineStep> = {},
): PipelineStep {
  return {
    stepKey,
    stepName: stepKey,
    stepDescription: null,
    position,
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
  return {
    key,
    name: key,
    description: null,
    version: 1,
    status: "active",
    steps: [...steps],
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
