// Topological-order utility for the SDK's compiled pipeline graph.
//
// #162's own scope is chain-only: every node has at most one incoming and one
// outgoing dependency edge. This is deliberately generalizable — #167 (fan-out
// DSL) will need a richer version of this walk, but today's callers
// (`upsertFromSpec`, `validate-definition-specs`) only ever need "is this a
// single valid chain, and if so what order does it run in".

import type {
  DependencyEdgeSpec,
  NodeDefinitionSpec,
} from "./define-pipeline";

/**
 * Orders `nodeDefinitions` by walking `dependencyEdges` from the single root
 * to the single leaf. Returns `null` (does not throw) on any structural
 * problem: multiple roots, a node with more than one outgoing edge, a node
 * with more than one incoming edge, a cycle, or a disconnected node.
 */
export function tryOrderChainNodeDefinitions(
  nodeDefinitions: readonly NodeDefinitionSpec[],
  dependencyEdges: readonly DependencyEdgeSpec[],
): NodeDefinitionSpec[] | null {
  const nodesByKey = new Map<string, NodeDefinitionSpec>();
  for (const nodeDefinition of nodeDefinitions) {
    nodesByKey.set(nodeDefinition.nodeKey, nodeDefinition);
  }

  const outgoing = new Map<string, string>();
  const incomingCount = new Map<string, number>();
  for (const nodeDefinition of nodeDefinitions) {
    incomingCount.set(nodeDefinition.nodeKey, 0);
  }

  for (const edge of dependencyEdges) {
    if (!nodesByKey.has(edge.fromNodeKey) || !nodesByKey.has(edge.toNodeKey)) {
      return null;
    }
    if (outgoing.has(edge.fromNodeKey)) return null;
    outgoing.set(edge.fromNodeKey, edge.toNodeKey);
    incomingCount.set(
      edge.toNodeKey,
      (incomingCount.get(edge.toNodeKey) ?? 0) + 1,
    );
  }

  for (const count of incomingCount.values()) {
    if (count > 1) return null;
  }

  if (nodeDefinitions.length === 0) return [];

  const roots = nodeDefinitions.filter(
    (nodeDefinition) => (incomingCount.get(nodeDefinition.nodeKey) ?? 0) === 0,
  );
  if (roots.length !== 1) return null;

  const rootNode = roots[0];
  if (!rootNode) return null;

  const ordered: NodeDefinitionSpec[] = [];
  const visited = new Set<string>();
  let currentKey: string | undefined = rootNode.nodeKey;

  while (currentKey !== undefined) {
    if (visited.has(currentKey)) return null;
    visited.add(currentKey);

    const currentNode = nodesByKey.get(currentKey);
    if (!currentNode) return null;
    ordered.push(currentNode);

    currentKey = outgoing.get(currentKey);
  }

  if (ordered.length !== nodeDefinitions.length) return null;

  return ordered;
}

/**
 * Builds one dependency edge between each consecutive pair of `orderedNodes`,
 * in the order given. Used to synthesize a chain's edges from an already-known
 * author order (e.g. declaration order in `.step()` calls).
 */
export function buildChainDependencyEdges(
  orderedNodes: readonly Pick<NodeDefinitionSpec, "nodeKey">[],
): DependencyEdgeSpec[] {
  const dependencyEdges: DependencyEdgeSpec[] = [];
  for (let index = 0; index < orderedNodes.length - 1; index += 1) {
    const from = orderedNodes[index];
    const to = orderedNodes[index + 1];
    if (!from || !to) continue;
    dependencyEdges.push({ fromNodeKey: from.nodeKey, toNodeKey: to.nodeKey });
  }
  return dependencyEdges;
}

/**
 * `tryOrderChainNodeDefinitions`, but throws a descriptive error instead of
 * returning `null` when the graph isn't a single valid chain.
 */
export function orderChainNodeDefinitions(
  nodeDefinitions: readonly NodeDefinitionSpec[],
  dependencyEdges: readonly DependencyEdgeSpec[],
): NodeDefinitionSpec[] {
  const ordered = tryOrderChainNodeDefinitions(
    nodeDefinitions,
    dependencyEdges,
  );
  if (ordered === null) {
    const nodeKeys = nodeDefinitions.map((n) => n.nodeKey).join(", ");
    throw new Error(
      `Pipeline graph is not a single valid chain: nodes [${nodeKeys}] and ` +
        `${String(dependencyEdges.length)} dependency edge(s) do not form a ` +
        `connected, acyclic, single-incoming/single-outgoing chain.`,
    );
  }
  return ordered;
}
