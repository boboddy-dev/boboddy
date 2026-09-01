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
     * `entrypointJson` (a `kind: "code"` step's resolved entrypoint — see
     * `collect-definitions.ts`) and the widened `kind` union
     * (`"user_defined" | "code"`) are not yet reflected in the
     * OpenAPI-generated `UpsertStepDefinitionInput` type, so the request
     * body is built explicitly and cast at the boundary rather than spread
     * + `satisfies`-checked, mirroring the same pattern
     * `pipeline-definitions-client.ts`'s `upsertFromSpec` already uses for
     * its own wire-format-ahead-of-codegen gap. The spec's transient
     * `entrypoint.fn` (a live, unserializable function reference —
     * present only if a caller bypasses `collect-definitions.ts`'s own
     * strip step) is never included here.
     */
    upsertFromSpec: async (
      projectId: string,
      spec: StepDefinitionSpec,
      options?: RequestOptions,
    ) => {
      const body = {
        key: spec.key,
        name: spec.name,
        description: spec.description,
        prompt: spec.prompt ?? "",
        version: spec.version,
        kind: spec.kind,
        entrypointJson: spec.entrypointJson ?? null,
        executionMode: spec.executionMode,
        inputSchemaJson: spec.inputSchemaJson,
        resultSchemaJson: spec.resultSchemaJson,
        opencodeMcpJson: spec.opencodeMcpJson,
        opencodePluginJson: spec.opencodePluginJson,
        healthChecksJson: spec.healthChecksJson,
        status: spec.status,
        signalExtractorDefinitions: spec.signalExtractorDefinitions,
        projectId,
      } as unknown as UpsertStepDefinitionInput;
      const result = await stepDefinitions.upsertStepDefinition({
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
  };
};
