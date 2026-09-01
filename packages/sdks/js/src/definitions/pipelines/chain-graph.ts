// General reachability/topological-order + cycle-detection pass over the
// SDK's compiled pipeline graph.
//
// No longer "chain-only" (its original #162 scope, when every node had at
// most one incoming/outgoing edge): `definePipeline()`'s `choice`/`loop`
// states legitimately produce branching, even convergent, graphs (see
// docs/research/flat-pipeline-sdk-and-visual-designer.md §6). This mirrors
// `computeTopoRanks`'s Kahn's-algorithm approach in
// `packages/core`'s `pipeline-graph-version-entity.ts`, so
// `validate-definition-specs.ts` can order nodes for its "does this signal
// binding run before its consumer" check against branching graphs, not
// just single chains.

import type {
  DependencyEdgeSpec,
  NodeDefinitionSpec,
} from "./define-pipeline";

/**
 * Computes, for every node key, the longest-path-from-root depth ("topo
 * rank") over the given edges, using Kahn's algorithm — identical in
 * approach to `packages/core`'s own `computeTopoRanks`. Returns `null`
 * (does not throw) if the graph contains a cycle, or if `dependencyEdges`
 * references a node key outside `nodeDefinitions` (a malformed/hand-edited
 * spec) — every caller here is a diagnostic tool, not a build-time
 * assertion, so it degrades gracefully rather than crashing the whole
 * validation pass.
 */
export function tryComputeTopoRanks(
  nodeDefinitions: readonly Pick<NodeDefinitionSpec, "nodeKey">[],
  dependencyEdges: readonly DependencyEdgeSpec[],
): Map<string, number> | null {
  const nodeKeys = new Set(nodeDefinitions.map((node) => node.nodeKey));
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const key of nodeKeys) {
    outgoing.set(key, []);
    inDegree.set(key, 0);
  }

  for (const edge of dependencyEdges) {
    if (!nodeKeys.has(edge.fromNodeKey) || !nodeKeys.has(edge.toNodeKey)) {
      return null;
    }
    outgoing.get(edge.fromNodeKey)?.push(edge.toNodeKey);
    inDegree.set(edge.toNodeKey, (inDegree.get(edge.toNodeKey) ?? 0) + 1);
  }

  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const key of nodeKeys) {
    if ((inDegree.get(key) ?? 0) === 0) {
      rank.set(key, 0);
      queue.push(key);
    }
  }

  let visitedCount = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    visitedCount += 1;

    for (const next of outgoing.get(current) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(current) ?? 0) + 1));
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (visitedCount !== nodeKeys.size) return null;
  return rank;
}

/**
 * `tryComputeTopoRanks`, ordering `nodeDefinitions` by ascending rank (ties
 * broken by declaration order) instead of returning the raw rank map —
 * the shape `validate-definition-specs.ts`'s "runs before its consumer"
 * check wants directly. Returns `null` under the same conditions
 * `tryComputeTopoRanks` does.
 */
export function tryOrderNodeDefinitionsByTopoRank(
  nodeDefinitions: readonly NodeDefinitionSpec[],
  dependencyEdges: readonly DependencyEdgeSpec[],
): NodeDefinitionSpec[] | null {
  const rankByKey = tryComputeTopoRanks(nodeDefinitions, dependencyEdges);
  if (rankByKey === null) return null;

  return nodeDefinitions
    .map((node, declarationIndex) => ({ node, declarationIndex }))
    .sort((left, right) => {
      const rankDiff =
        (rankByKey.get(left.node.nodeKey) ?? 0) -
        (rankByKey.get(right.node.nodeKey) ?? 0);
      return rankDiff !== 0
        ? rankDiff
        : left.declarationIndex - right.declarationIndex;
    })
    .map(({ node }) => node);
}
