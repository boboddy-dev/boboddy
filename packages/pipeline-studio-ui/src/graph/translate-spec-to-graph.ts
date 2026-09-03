// Pure `PipelineDefinitionSpec` → React Flow `{nodes, edges}` translation (see
// docs/research/flat-pipeline-sdk-and-visual-designer.md §10). No I/O, no
// randomness: the same spec + issues always produce the same graph, which is
// what lets this run identically in the browser and (for the SSE payload
// server-side, see `@boboddy/worker`'s `compute-studio-snapshot.ts`) in Bun.
//
// `@xyflow/react`'s `Node`/`Edge` are imported type-only in
// `studio-graph-types.ts`, so importing THIS module's types alone never pulls
// in React or the React Flow runtime — only `dagre` (a plain graph-layout
// library with no DOM dependency) is a real runtime dependency here, which is
// why the worker's server can call `translateSpecToGraph` directly instead of
// duplicating the layout logic.
import dagre from "dagre";
import {
  isWorkingNodeDefinition,
  type DependencyEdgeSpec,
  type NodeDefinitionSpec,
  type ParallelBranchSpec,
  type PipelineDefinitionSpec,
  type SerializedBinding,
} from "@boboddy/sdk/definitions/pipelines";
import type { StepDefinitionSpec } from "@boboddy/sdk/definitions/steps";
import {
  resolveSchemaType,
  type DefinitionValidationIssue,
  type JsonSchemaNode,
} from "@boboddy/sdk/definitions/validation";
import type {
  PipelineGraphSnapshot,
  StudioEdge,
  StudioNode,
  StudioNodeInputField,
  StudioNodeOutputSignal,
  StudioNodeShape,
  StudioParallelBranchShape,
} from "./studio-graph-types";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

function nodeLabel(node: NodeDefinitionSpec): string {
  return isWorkingNodeDefinition(node) ? node.stepName : node.nodeKey;
}

// ─── Node/branch shape: a consumer step's input/output/result, for display ───
//
// Presentation-only mirror of `validate-input-bindings.ts`'s binding-shape
// reads — same general approach (read `inputSchemaJson.properties`/
// `required` off the step, resolve each property's type via
// `resolveSchemaType`), but simplified: no cross-version unioning (studio is
// local/offline, so `stepsByKey` picking the first version present per key
// is enough — see `stepsByKey` below), and `describeBindingSource` here is a
// short, human-readable label for display, not an error-message fragment.

// This is the narrowing boundary for raw JSON read off a step's
// `inputSchemaJson` — mirrors `validate-input-bindings.ts`'s own
// `isJsonSchemaNode`.
// eslint-disable-next-line local/no-unknown-parameter-type
function isJsonSchemaNode(value: unknown): value is JsonSchemaNode {
  return (
    typeof value === "boolean" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  );
}

/**
 * A short, human-readable description of what a bound field resolves to —
 * e.g. `signal "diff" of analyze`, `output of analyze`,
 * `pipeline input "x"`, `work_item.title`, `literal value`, `fan-out item`.
 * Presentation-only: doesn't need to match `validate-input-bindings.ts`'s
 * private `describeBindingSource` verbatim, though matching its general
 * voice is fine.
 */
function describeBindingSource(binding: SerializedBinding): string {
  switch (binding.source) {
    case "step_signal":
      return `signal "${binding.signalKey}" of ${binding.stepKey}`;
    case "step_output":
      return `output of ${binding.stepKey}`;
    case "signals_list":
      return `signals list of ${binding.stepKey}`;
    case "pipeline_input":
      return `pipeline input "${binding.path}"`;
    case "work_item":
      return `work_item.${binding.field}`;
    case "literal":
      return "literal value";
    case "fan_out_item":
      return "fan-out item";
  }
}

/**
 * A consumer step's `additionalInput` fields, as declared on
 * `inputSchemaJson.properties`/`required` ONLY — deliberately excludes the
 * two always-auto-bound `workItemTitle`/`workItemDescription` fields (see
 * `bindings.ts`'s `serializeInputBindings`): they're fixed plumbing present
 * on every working node, not step-declared shape, and including them would
 * make every node's field count off by two with no useful signal.
 */
function stepInputFields(
  step: StepDefinitionSpec,
  inputBindingsJson: Record<string, SerializedBinding>,
): StudioNodeInputField[] {
  const schema = step.inputSchemaJson;
  if (!schema) return [];

  const properties = schema["properties"];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }

  const required = schema["required"];
  const requiredFields = new Set(
    Array.isArray(required)
      ? required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );

  return Object.entries(properties as Record<string, unknown>)
    .filter((entry): entry is [string, JsonSchemaNode] => isJsonSchemaNode(entry[1]))
    .map(([name, node]) => {
      const binding = inputBindingsJson[name];
      return {
        name,
        type: resolveSchemaType(node, schema),
        required: requiredFields.has(name),
        boundTo: binding ? describeBindingSource(binding) : null,
      };
    });
}

/** A consumer step's declared output signals, as-is off `signalExtractorDefinitions`. */
function stepOutputSignals(step: StepDefinitionSpec): StudioNodeOutputSignal[] {
  return step.signalExtractorDefinitions.map((signal) => ({
    key: signal.key,
    // `SignalTypeStr` (this field's declared type) is a private, strict
    // subset of the public `SchemaType` — see `define-step.ts`.
    type: signal.type,
    required: signal.required,
  }));
}

/**
 * Picks the first version present for a given step key — studio is
 * local/offline, and in practice there's exactly one version collected per
 * key, so (unlike the correctness-critical validation checks in
 * `validate-input-bindings.ts`) there's no need to union facts across
 * versions for this display-only lookup.
 */
function buildStepsByKey(
  steps: readonly StepDefinitionSpec[],
): Map<string, StepDefinitionSpec> {
  const byKey = new Map<string, StepDefinitionSpec>();
  for (const step of steps) {
    if (!byKey.has(step.key)) byKey.set(step.key, step);
  }
  return byKey;
}

function branchShape(
  branchKey: string,
  branch: ParallelBranchSpec,
  stepsByKey: ReadonlyMap<string, StepDefinitionSpec>,
  branchIssues: DefinitionValidationIssue[],
): StudioParallelBranchShape {
  const step = stepsByKey.get(branch.stepKey);
  return {
    key: branchKey,
    label: branch.stepName,
    inputFields: step ? stepInputFields(step, branch.inputBindingsJson) : null,
    issues: branchIssues,
  };
}

/**
 * A node's step-derived shape — see `StudioNodeShape`'s own doc comment for
 * the discriminant and the `"none"` fallback rules.
 */
function buildNodeShape(
  node: NodeDefinitionSpec,
  stepsByKey: ReadonlyMap<string, StepDefinitionSpec>,
  nodeIssues: readonly DefinitionValidationIssue[],
): StudioNodeShape {
  if (isWorkingNodeDefinition(node)) {
    const step = stepsByKey.get(node.stepKey);
    if (!step) return { kind: "none" };
    return {
      kind: "step",
      inputFields: stepInputFields(step, node.inputBindingsJson),
      outputSignals: stepOutputSignals(step),
      resultSchemaJson: step.resultSchemaJson,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hand-edited/generated spec may claim `kind: "parallel"` without setting `branches`
  if (node.kind === "parallel" && node.branches) {
    const branches = Object.entries(node.branches).map(([branchKey, branch]) =>
      branchShape(
        branchKey,
        branch,
        stepsByKey,
        nodeIssues.filter((issue) => issue.branchKey === branchKey),
      ),
    );
    return { kind: "parallel", branches };
  }

  return { kind: "none" };
}

/**
 * Issues relevant to this pipeline, in the shape `checkRouteTargets`/
 * `checkSignalBindings` actually produce: `pipelineKey` set to this
 * pipeline's own key. Step-only checks (`signal-source-path`,
 * `health-check-*`) never carry a `pipelineKey` and are excluded here — they
 * have no `nodeKey` either, so they could never attach to a node/edge below
 * regardless; the caller is responsible for still surfacing them elsewhere
 * (see `StudioSnapshot.validationIssues`).
 */
function issuesForPipeline(
  spec: PipelineDefinitionSpec,
  issues: readonly DefinitionValidationIssue[],
): DefinitionValidationIssue[] {
  return issues.filter((issue) => issue.pipelineKey === spec.key);
}

/**
 * True when `fromNodeKey -> toNodeKey` (in either direction) is a real,
 * compiler-derived edge in this pipeline — used to decide whether a
 * `signal-binding` issue (which names a `nodeKey`/`targetNodeKey` pair that
 * need not be directly connected) should attach to the edge itself or, when
 * there is no such edge, fall back to the consuming node.
 */
function findDirectEdge(
  edges: readonly DependencyEdgeSpec[],
  a: string,
  b: string,
): DependencyEdgeSpec | undefined {
  return edges.find(
    (edge) =>
      (edge.fromNodeKey === a && edge.toNodeKey === b) ||
      (edge.fromNodeKey === b && edge.toNodeKey === a),
  );
}

function edgeId(edge: DependencyEdgeSpec): string {
  return `${edge.fromNodeKey}->${edge.toNodeKey}`;
}

/** Builds every node/edge with placeholder positions, before dagre lays them out. */
function buildRawGraph(
  spec: PipelineDefinitionSpec,
  issues: readonly DefinitionValidationIssue[],
  stepsByKey: ReadonlyMap<string, StepDefinitionSpec>,
): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const nodeIssues = new Map<string, DefinitionValidationIssue[]>();
  const edgeIssues = new Map<string, DefinitionValidationIssue[]>();

  const addNodeIssue = (nodeKey: string, issue: DefinitionValidationIssue) => {
    const existing = nodeIssues.get(nodeKey);
    if (existing) existing.push(issue);
    else nodeIssues.set(nodeKey, [issue]);
  };
  const addEdgeIssue = (id: string, issue: DefinitionValidationIssue) => {
    const existing = edgeIssues.get(id);
    if (existing) existing.push(issue);
    else edgeIssues.set(id, [issue]);
  };

  for (const issue of issuesForPipeline(spec, issues)) {
    if (issue.nodeKey === undefined) continue;

    const direct =
      issue.targetNodeKey !== undefined
        ? findDirectEdge(spec.dependencyEdges, issue.nodeKey, issue.targetNodeKey)
        : undefined;

    if (direct) {
      addEdgeIssue(edgeId(direct), issue);
    } else {
      addNodeIssue(issue.nodeKey, issue);
    }
  }

  const nodes: StudioNode[] = spec.nodeDefinitions.map((node) => {
    const issuesForNode = nodeIssues.get(node.nodeKey) ?? [];
    return {
      id: node.nodeKey,
      position: { x: 0, y: 0 },
      data: {
        label: nodeLabel(node),
        kind: node.kind,
        stepKey: isWorkingNodeDefinition(node) ? node.stepKey : undefined,
        issues: issuesForNode,
        shape: buildNodeShape(node, stepsByKey, issuesForNode),
      },
    };
  });

  const edges: StudioEdge[] = spec.dependencyEdges.map((edge) => ({
    id: edgeId(edge),
    source: edge.fromNodeKey,
    target: edge.toNodeKey,
    label:
      typeof edge.discriminantJson?.["loopExit"] === "string"
        ? edge.discriminantJson["loopExit"]
        : undefined,
    data: { issues: edgeIssues.get(edgeId(edge)) ?? [] },
  }));

  return { nodes, edges };
}

/** Runs dagre over the raw graph and writes each node's computed position back in. */
function layoutGraph(nodes: StudioNode[], edges: StudioEdge[]): StudioNode[] {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 96 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    const laidOut = graph.node(node.id) as { x: number; y: number } | undefined;
    if (!laidOut) return node;
    // dagre positions are node-centered; React Flow positions from the
    // top-left corner.
    return {
      ...node,
      position: {
        x: laidOut.x - NODE_WIDTH / 2,
        y: laidOut.y - NODE_HEIGHT / 2,
      },
    };
  });
}

/**
 * Translates one pipeline's compiled spec into a React Flow graph, with every
 * enriched `DefinitionValidationIssue` attached to the node (or, when it
 * names a real edge, the edge) it is about. Positions are always
 * auto-computed by `dagre` here — never persisted or author-supplied,
 * consistent with the designer's "no two-way editing" v1 scope.
 *
 * `steps` is the batch of step specs this pipeline's nodes reference — used
 * only to resolve each node's `shape` (see `StudioNodeShape`). Pass `[]`
 * when no step specs are available (e.g. hand-authored fixtures with no
 * separate step collection) — every node's `shape` then falls back to
 * `{kind: "none"}`.
 */
export function translateSpecToGraph(
  spec: PipelineDefinitionSpec,
  issues: readonly DefinitionValidationIssue[],
  steps: readonly StepDefinitionSpec[] = [],
): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const stepsByKey = buildStepsByKey(steps);
  const { nodes, edges } = buildRawGraph(spec, issues, stepsByKey);
  return { nodes: layoutGraph(nodes, edges), edges };
}

/** `translateSpecToGraph`, wrapped with the pipeline's own key/name. */
export function translatePipelineToSnapshot(
  spec: PipelineDefinitionSpec,
  issues: readonly DefinitionValidationIssue[],
  steps: readonly StepDefinitionSpec[] = [],
): PipelineGraphSnapshot {
  const { nodes, edges } = translateSpecToGraph(spec, issues, steps);
  return { key: spec.key, name: spec.name, nodes, edges };
}

export type {
  PipelineGraphSnapshot,
  StudioEdge,
  StudioEdgeData,
  StudioNode,
  StudioNodeData,
  StudioNodeInputField,
  StudioNodeOutputSignal,
  StudioNodeShape,
  StudioParallelBranchShape,
  StudioSnapshot,
} from "./studio-graph-types";
export type { BrokenPipeline } from "@boboddy/sdk/push";
