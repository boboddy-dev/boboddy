import { createClient } from "../../generated/client";
import { PipelineDefinitions } from "../../generated/sdk.gen";
import type { PutApiPipelineDefinitionsData } from "../../generated/types.gen";
import { tryOrderChainNodeDefinitions } from "./chain-graph";
import type { PipelineDefinitionSpec } from "./define-pipeline";

type RequestOptions = {
  headers?: Record<string, unknown> | undefined;
};

export type UpsertPipelineDefinitionInput =
  PutApiPipelineDefinitionsData["body"];

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
    listByProjectId: async (projectId: string, options?: RequestOptions) => {
      const result = await pipelineDefinitions.listPipelineDefinitions({
        path: { projectId },
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
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

      const nonStepNode = spec.nodeDefinitions.find(
        (node) => node.kind !== "step",
      );
      if (nonStepNode) {
        // `.fanOutStep()` (issue #167) compiles to `fanOut`/`cohortGate` node
        // definitions, but the wire contract
        // this client pushes through (`upsertPipelineDefinitionInputSchema`)
        // is still chain-only/step-only — extending it is explicitly out of
        // scope for #167. Fail loudly here rather than silently mis-pushing
        // a broken/partial pipeline definition.
        throw new Error(
          `Pipeline "${spec.key}" contains a "${nonStepNode.kind}" node ("${nonStepNode.nodeKey}"), ` +
            `but fan-out pipelines cannot be pushed via the current wire contract yet. ` +
            `Only "step"-only (chain) pipelines can be pushed with \`upsertFromSpec\` today.`,
        );
      }

      const ordered = tryOrderChainNodeDefinitions(
        spec.nodeDefinitions,
        spec.dependencyEdges,
      );
      if (ordered === null) {
        throw new Error(
          `Pipeline "${spec.key}" has a malformed step graph: its node and ` +
            `dependency-edge definitions do not form a single connected, ` +
            `acyclic chain. This should not happen from the \`pipeline()\` ` +
            `builder — check for hand-edited or generated pipeline specs.`,
        );
      }

      const stepDefinitions = ordered.map((node, index) => {
        const stepKey = node.stepKey;
        if (!stepKey) {
          throw new Error(
            `Node "${node.nodeKey}" in pipeline "${spec.key}" has no stepKey.`,
          );
        }
        const stepDef = stepDefMap.get(stepKey);
        if (!stepDef) {
          throw new Error(
            `Step "${stepKey}" referenced in pipeline "${spec.key}" was not found on the server. ` +
              `Run \`boboddy steps push\` first to push your step definitions.`,
          );
        }
        return {
          stepDefinitionId: stepDef.id,
          stepDefinitionVersion: stepDef.version,
          key: node.nodeKey,
          name: node.stepName ?? "",
          description: node.stepDescription ?? null,
          position: index + 1,
          inputBindingsJson: node.inputBindingsJson ?? {},
          timeoutSeconds: node.timeoutSeconds ?? null,
          retryPolicyJson: null,
          advancementPolicyDefinition: node.advancementPolicyDefinition,
          computedSignalDefinitions: node.computedSignalDefinitions ?? [],
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
