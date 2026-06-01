import { createClient } from "../../generated/client";
import { PipelineDefinitions } from "../../generated/sdk.gen";
import type { PutApiLinearPipelineDefinitionsData } from "../../generated/types.gen";
import type { PipelineDefinitionSpec } from "./define-pipeline";

type RequestOptions = {
  headers?: Record<string, unknown> | undefined;
};

export type UpsertPipelineDefinitionInput =
  PutApiLinearPipelineDefinitionsData["body"];

export type StepDefinitionRef = {
  id: string;
  key: string;
  version: number;
};

export function createPipelineDefinitionsClient(
  baseUrl: string,
): ReturnType<typeof buildPipelineDefinitionsClient> {
  const client = createClient({ baseUrl });
  return buildPipelineDefinitionsClient(new PipelineDefinitions({ client }));
}

const buildPipelineDefinitionsClient = (
  pipelineDefinitions: PipelineDefinitions,
) => {
  return {
    listByProjectId: async (
      projectId: string,
      options?: RequestOptions,
    ) => {
      const result = await pipelineDefinitions.listPipelineDefinitions({
        path: { projectId },
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data ?? [];
    },
    /**
     * Upserts a pipeline definition keyed by (projectId, key). Accepts the
     * `PipelineDefinitionSpec` produced by `pipeline().build()`, along with the
     * list of pushed step definitions (used to resolve `stepDefinitionId` for
     * each pipeline step).
     *
     * Throws if any pipeline step references a step key/version that isn't
     * present in `stepDefs`.
     */
    upsertFromSpec: async (
      projectId: string,
      spec: PipelineDefinitionSpec,
      stepDefs: ReadonlyArray<StepDefinitionRef>,
      options?: RequestOptions,
    ) => {
      const stepDefMap = new Map<string, StepDefinitionRef>();
      for (const s of stepDefs) {
        const existing = stepDefMap.get(s.key);
        if (!existing || s.version > existing.version) {
          stepDefMap.set(s.key, s);
        }
      }

      const stepDefinitions = spec.steps.map((step) => {
        const stepDef = stepDefMap.get(step.stepKey);
        if (!stepDef) {
          throw new Error(
            `Step "${step.stepKey}" referenced in pipeline "${spec.key}" was not found on the server. ` +
              `Run \`boboddy steps push\` first to push your step definitions.`,
          );
        }
        return {
          stepDefinitionId: stepDef.id,
          stepDefinitionVersion: stepDef.version,
          key: step.stepKey,
          name: step.stepName,
          description: step.stepDescription,
          position: step.position,
          inputBindingsJson: step.inputBindingsJson,
          timeoutSeconds: step.timeoutSeconds,
          retryPolicyJson: null,
          advancementPolicyDefinition: step.advancementPolicyDefinition,
          computedSignalDefinitions: step.computedSignalDefinitions,
        };
      });

      const body = {
        projectId,
        key: spec.key,
        name: spec.name,
        description: spec.description,
        status: spec.status,
        inputSchemaJson: spec.inputSchemaJson,
        stepDefinitions,
      } as unknown as UpsertPipelineDefinitionInput;

      const result = await pipelineDefinitions.upsertPipelineDefinition({
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
  };
};
