import { createClient } from "../../generated/client";
import { StepDefinitions } from "../../generated/sdk.gen";
import type {
  PostApiStepDefinitionsData,
  PutApiStepDefinitionsData,
} from "../../generated/types.gen";
import type { StepDefinitionSpec } from "./define-step";

type RequestOptions = {
  headers?: Record<string, unknown> | undefined;
};

export type CreateStepDefinitionInput = PostApiStepDefinitionsData["body"];
export type UpsertStepDefinitionInput = PutApiStepDefinitionsData["body"];

export function createStepDefinitionsClient(
  baseUrl: string,
): ReturnType<typeof buildStepDefinitionsClient> {
  const client = createClient({ baseUrl });
  return buildStepDefinitionsClient(new StepDefinitions({ client }));
}

const buildStepDefinitionsClient = (stepDefinitions: StepDefinitions) => {
  return {
    listByProjectId: async (projectId: string, options?: RequestOptions) => {
      const result = await stepDefinitions.listStepDefinitions({
        query: { projectId },
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    create: async (
      body: CreateStepDefinitionInput,
      options?: RequestOptions,
    ) => {
      const result = await stepDefinitions.createStepDefinition({
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    /**
     * Upserts a step definition keyed by (projectId, key, version). Accepts the
     * `StepDefinitionSpec` produced by `defineStep()`/`codeStep()` directly —
     * no separate fetch-existing/branch-on-id step needed.
     *
     * The request body is built field by field so the spec's transient
     * `entrypoint.fn` (a live, unserializable function reference — present
     * only if a caller bypasses `collect-definitions.ts`'s own strip step)
     * is never included.
     */
    upsertFromSpec: async (
      projectId: string,
      spec: StepDefinitionSpec,
      options?: RequestOptions,
    ) => {
      const body: UpsertStepDefinitionInput = {
        key: spec.key,
        name: spec.name,
        description: spec.description,
        prompt: spec.prompt ?? null,
        version: spec.version,
        kind: spec.kind,
        entrypointJson: spec.entrypointJson ?? null,
        executionMode: spec.executionMode,
        devcontainerConfigPath: spec.devcontainerConfigPath,
        managedRuntime: spec.managedRuntime,
        repo: spec.repo,
        inputSchemaJson: spec.inputSchemaJson,
        resultSchemaJson: spec.resultSchemaJson,
        opencodeMcpJson: spec.opencodeMcpJson,
        opencodePluginJson: spec.opencodePluginJson,
        healthChecksJson: spec.healthChecksJson,
        envJson: spec.envJson,
        status: spec.status,
        signalExtractorDefinitions: spec.signalExtractorDefinitions,
        projectId,
      };
      const result = await stepDefinitions.upsertStepDefinition({
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
  };
};
