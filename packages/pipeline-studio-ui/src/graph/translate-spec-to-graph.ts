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
  type PipelineDefinitionSpec,
} from "@boboddy/sdk/definitions/pipelines";
import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import type {
  PipelineGraphSnapshot,
  StudioEdge,
  StudioNode,
} from "./studio-graph-types";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

function nodeLabel(node: NodeDefinitionSpec): string {
  return isWorkingNodeDefinition(node) ? node.stepName : node.nodeKey;
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

  const nodes: StudioNode[] = spec.nodeDefinitions.map((node) => ({
    id: node.nodeKey,
    position: { x: 0, y: 0 },
    data: {
      label: nodeLabel(node),
      kind: node.kind,
      stepKey: isWorkingNodeDefinition(node) ? node.stepKey : undefined,
      issues: nodeIssues.get(node.nodeKey) ?? [],
    },
  }));

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
 */
export function translateSpecToGraph(
  spec: PipelineDefinitionSpec,
  issues: readonly DefinitionValidationIssue[],
): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const { nodes, edges } = buildRawGraph(spec, issues);
  return { nodes: layoutGraph(nodes, edges), edges };
}

/** `translateSpecToGraph`, wrapped with the pipeline's own key/name. */
export function translatePipelineToSnapshot(
  spec: PipelineDefinitionSpec,
  issues: readonly DefinitionValidationIssue[],
): PipelineGraphSnapshot {
  const { nodes, edges } = translateSpecToGraph(spec, issues);
  return { key: spec.key, name: spec.name, nodes, edges };
}

export type {
  PipelineGraphSnapshot,
  StudioEdge,
  StudioEdgeData,
  StudioNode,
  StudioNodeData,
  StudioSnapshot,
} from "./studio-graph-types";
export type { BrokenPipeline } from "@boboddy/sdk/push";
