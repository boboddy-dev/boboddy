import {
  generatePipelineFileContent,
  type PipelineContract,
  type PipelineStepContract,
} from "../../../../src/pipelines/pipeline-definitions/infra/pipeline-file-generator";

export const NO_ADVANCEMENT = {
  rulesJson: { rules: [] },
  defaultEventType: "continue",
  defaultEventParamsJson: null,
  allowedEventTypes: ["continue"],
};

export function makeStep(overrides: Partial<PipelineStepContract> = {}): PipelineStepContract {
  return {
    stepDefinitionId: "def-id",
    stepDefinitionVersion: 1,
    key: "review-code",
    name: "Review Code",
    description: null,
    position: 0,
    inputBindingsJson: null,
    timeoutSeconds: null,
    advancementPolicyDefinition: NO_ADVANCEMENT,
    computedSignalDefinitions: [],
    ...overrides,
  };
}

export function makePipeline(
  steps: PipelineStepContract[],
  overrides: Partial<PipelineContract> = {},
): PipelineContract {
  return {
    key: "my-pipeline",
    name: "My Pipeline",
    description: null,
    version: 1,
    status: "active",
    inputSchemaJson: null,
    stepDefinitions: steps,
    ...overrides,
  };
}

export function gen(pipeline: PipelineContract): string {
  return generatePipelineFileContent(pipeline, new Map());
}
