import { createClient } from "../../generated/client";
import { PipelineDefinitions } from "../../generated/sdk.gen";
import type { PutApiPipelineDefinitionsData } from "../../generated/types.gen";
import {
  isWorkingNodeDefinition,
  type NodeDefinitionSpec,
  type PipelineDefinitionSpec,
} from "./define-pipeline";

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

/** Resolves a `stepKey` against the pushed step-definitions list, or throws with a helpful message. */
function resolveStepRef(
  pipelineKey: string,
  nodeKey: string,
  stepKey: string,
  stepDefMap: ReadonlyMap<string, StepDefinitionRef>,
): { stepDefinitionId: string; stepDefinitionVersion: number } {
  const stepDef = stepDefMap.get(stepKey);
  if (!stepDef) {
    throw new Error(
      `Step "${stepKey}" referenced by node "${nodeKey}" in pipeline "${pipelineKey}" was not found on ` +
        `the server. Run \`boboddy steps push\` first to push your step definitions.`,
    );
  }
  return {
    stepDefinitionId: stepDef.id,
    stepDefinitionVersion: stepDef.version,
  };
}

/**
 * Builds one node's `configJson` from its kind-specific `NodeDefinitionSpec`
 * fields — the richer `nodeDefinitions[]`/`dependencyEdges[]` graph shape's
 * counterpart to a chain node's flat `position`-ordered row (see
 * docs/research/flat-pipeline-sdk-and-visual-designer.md §11 Phase 3's
 * wire-format resolution). `choice`/`loop`'s configs are plain data (no
 * step-key resolution needed); `parallel`'s branches each carry their own
 * `stepKey` that must be resolved the same way a top-level node's does.
 */
function buildConfigJson(
  pipelineKey: string,
  node: NodeDefinitionSpec,
  stepDefMap: ReadonlyMap<string, StepDefinitionRef>,
): Record<string, unknown> | null {
  if (node.kind === "choice") {
    return { choices: node.choices, default: node.default };
  }
  if (node.kind === "loop") {
    return {
      maxIterations: node.maxIterations,
      untilConditionJson: node.untilConditionJson,
    };
  }
  if (node.kind === "parallel") {
    const branches: Record<string, unknown> = {};
    for (const [branchKey, branch] of Object.entries(node.branches)) {
      branches[branchKey] = {
        ...resolveStepRef(pipelineKey, node.nodeKey, branch.stepKey, stepDefMap),
        inputBindingsJson: branch.inputBindingsJson,
      };
    }
    return {
      branches,
      ...(node.advanceAllPolicyDefinition
        ? { advanceAllPolicyDefinition: node.advanceAllPolicyDefinition }
        : {}),
    };
  }
  if (node.kind === "fanOut") {
    return {
      overSignalKey: node.overSignalKey,
      advanceEachPolicyDefinition: node.advanceEachPolicyDefinition,
      maxConcurrency: node.maxConcurrency,
    };
  }
  if (node.kind === "cohortGate") {
    return {
      advanceAllPolicyDefinition: node.advanceAllPolicyDefinition,
      stepSignalsListDefinitions: node.stepSignalsListDefinitions,
    };
  }
  // `step`/`succeed`/`fail` carry no configJson.
  return null;
}

function buildGraphNodeInput(
  pipelineKey: string,
  node: NodeDefinitionSpec,
  stepDefMap: ReadonlyMap<string, StepDefinitionRef>,
): Record<string, unknown> {
  // `stepKey`/`stepName`/`stepDescription`/`inputBindingsJson`/
  // `timeoutSeconds` only exist on working node kinds (mirrors the
  // server's `assertNodeDefinitionKindInvariants`): a non-working node
  // (e.g. `succeed`) must send a null `inputBindingsJson`, not `{}`, or it
  // trips `NODE_DEFINITION_INPUT_BINDINGS_NOT_ALLOWED`.
  const working = isWorkingNodeDefinition(node) ? node : null;

  const stepRef = working
    ? resolveStepRef(pipelineKey, node.nodeKey, working.stepKey, stepDefMap)
    : null;

  const policy = node.kind === "step" ? node.advancementPolicyDefinition : undefined;

  return {
    key: node.nodeKey,
    kind: node.kind,
    name: working?.stepName ?? node.nodeKey,
    ...(stepRef ?? {}),
    description: working?.stepDescription ?? null,
    inputBindingsJson: working ? working.inputBindingsJson : null,
    timeoutSeconds: working?.timeoutSeconds ?? null,
    ...(policy
      ? {
          advancementPolicyRulesJson: policy.rulesJson,
          advancementPolicyDefaultEventType: policy.defaultEventType,
          advancementPolicyDefaultEventParamsJson: policy.defaultEventParamsJson,
          advancementPolicyAllowedEventTypes: policy.allowedEventTypes,
        }
      : {}),
    configJson: buildConfigJson(pipelineKey, node, stepDefMap),
    computedSignalDefinitions: node.kind === "step" ? node.computedSignalDefinitions : [],
  };
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
     * `PipelineDefinitionSpec` produced by `definePipeline()`, along with the
     * list of pushed step definitions (used to resolve `stepDefinitionId` for
     * each node/branch referencing a step by key).
     *
     * Pushes via the richer `nodeDefinitions[]`/`dependencyEdges[]` graph
     * shape (see `buildGraphNodeInput`) rather than the old flat,
     * `position`-ordered `stepDefinitions[]` shape — every node kind
     * `definePipeline()` can produce (`choice`/`fanOut`/`cohortGate`/
     * `parallel`/`loop`/`succeed`/`fail`, not just `step`) is representable
     * this way; the flat shape could only ever represent a `step`-only
     * chain. The generated `UpsertPipelineDefinitionInput` type doesn't yet
     * reflect this (it's OpenAPI-codegen'd from the pre-existing flat
     * contract), so the body is cast at the boundary — the server's zod
     * schema (`createPipelineDefinitionInputSchema`, extended to accept
     * either shape) is the real, enforced contract.
     *
     * Throws if any node/branch references a step key/version that isn't
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

      const nodeDefinitions = spec.nodeDefinitions.map((node) =>
        buildGraphNodeInput(spec.key, node, stepDefMap),
      );
      const dependencyEdges = spec.dependencyEdges.map((edge) => ({
        fromNodeKey: edge.fromNodeKey,
        toNodeKey: edge.toNodeKey,
        discriminantJson: edge.discriminantJson ?? null,
      }));

      const body = {
        projectId,
        key: spec.key,
        name: spec.name,
        description: spec.description,
        status: spec.status,
        inputSchemaJson: spec.inputSchemaJson,
        nodeDefinitions,
        dependencyEdges,
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
