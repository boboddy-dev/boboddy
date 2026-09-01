// Spec builders shared by the `validateDefinitionSpecs` suites.
//
// The specs are hand-built rather than produced by `defineStep` / `pipeline()`
// on purpose: most of these fixtures are exactly the mistakes the builders (and,
// since the `SignalSpecInput` fix, the type system) refuse to make. The point of
// the runtime validator is the callers that bypass them — JS files, generated
// files, hand-edited files — so the tests have to bypass them too.

import { z } from "zod";
import type {
  SerializedAdvancementPolicy,
  SerializedComputedSignalDefinition,
} from "../src/definitions/advancement-policies";
import type {
  DependencyEdgeSpec,
  NodeDefinitionKind,
  NodeDefinitionSpec,
  PipelineDefinitionSpec,
} from "../src/definitions/pipelines";
import type { SerializedBinding } from "../src/definitions/pipelines/bindings";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import { validateDefinitionSpecs } from "../src/definitions/validation";

/** One dependency edge between each consecutive pair, in the order given. */
function buildSequentialEdges(
  nodeKeys: readonly string[],
): DependencyEdgeSpec[] {
  const edges: DependencyEdgeSpec[] = [];
  for (let index = 0; index < nodeKeys.length - 1; index += 1) {
    const from = nodeKeys[index];
    const to = nodeKeys[index + 1];
    if (!from || !to) continue;
    edges.push({ fromNodeKey: from, toNodeKey: to });
  }
  return edges;
}

/**
 * A loosely-typed node shape for building fixtures only. `NodeDefinitionSpec`
 * is a real discriminated union — each `kind` legally carries only its own
 * fields — but, per this file's header comment, these fixtures intentionally
 * build the malformed/incomplete node shapes the runtime validator exists to
 * catch (e.g. `fanOutNode()` in validate-definition-specs.test.ts overrides
 * `kind` to `"fanOut"` without filling in every `fanOut`-only field), so they
 * can't be typed as `NodeDefinitionSpec` itself. Cast to it at `pipelineSpec`,
 * the one boundary where these fixtures become "real" pipeline specs.
 */
type LooseNodeDefinition = {
  nodeKey: string;
  kind: NodeDefinitionKind;
  stepKey?: string;
  stepName?: string;
  stepDescription?: string | null;
  inputBindingsJson?: Record<string, SerializedBinding>;
  timeoutSeconds?: number | null;
  advancementPolicyDefinition?: SerializedAdvancementPolicy;
  computedSignalDefinitions?: SerializedComputedSignalDefinition[];
  overSignalKey?: string;
};

export type PipelineStep = LooseNodeDefinition & {
  /**
   * Fixture-only ordinal: how tests express "this step really runs Nth"
   * independent of array-literal order. Stripped before being placed into
   * `nodeDefinitions` — `pipelineSpec()` sorts by it and synthesizes
   * `dependencyEdges` from the sorted order instead.
   */
  __order: number;
};
export type Bindings = NonNullable<PipelineStep["inputBindingsJson"]>;

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
  const dependencyEdges = buildSequentialEdges(
    nodeDefinitions.map((node) => node.nodeKey),
  );

  return {
    key,
    name: key,
    description: null,
    version: 1,
    status: "active",
    // `LooseNodeDefinition[]` -> `NodeDefinitionSpec[]`: see that type's own
    // doc comment for why this fixture-only boundary bypasses the real
    // discriminated union.
    nodeDefinitions: nodeDefinitions as unknown as NodeDefinitionSpec[],
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
