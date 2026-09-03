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

/**
 * For every node reachable from `entryNodeKey`, the set of nodes that
 * *dominate* it — every node that appears on *every* path from the entry to
 * it, including the node itself (`dom(n)` always contains `n`). Standard
 * iterative dataflow (Cooper/Harvey/Kennedy-style):
 * `dom(entry) = {entry}`; `dom(n) = {n} ∪ ⋂ dom(p)` for each predecessor `p`
 * of `n`, iterated to a fixed point.
 *
 * Unlike `tryComputeTopoRanks` above — which deliberately treats *every*
 * in-degree-zero node as its own rank-0 root, so a graph with several
 * disconnected entry points still ranks (see lines 51-56) — a dominator
 * relation is only meaningful relative to a single root: "runs on every
 * path from the entry" has no answer if there could be more than one
 * entry. Callers must supply that root explicitly as `entryNodeKey`
 * (`PipelineDefinitionSpec.entryNodeKey`, the node `config.startAt` names)
 * rather than have it inferred from in-degree.
 *
 * Returns `null` (does not throw), same as `tryComputeTopoRanks`, when
 * `entryNodeKey` does not name a node in `nodeDefinitions`, when
 * `dependencyEdges` references a node key outside `nodeDefinitions`, or
 * when the graph contains a cycle — every caller here is a diagnostic
 * tool, not a build-time assertion (see `tryComputeTopoRanks`'s own doc
 * comment), so it degrades gracefully rather than crashing validation.
 *
 * Nodes unreachable from `entryNodeKey` are simply absent from the
 * returned map — an unreachable node can never appear on a path from the
 * entry, so it neither dominates nor is dominated by anything reachable.
 */
export function tryComputeDominators(
  nodeDefinitions: readonly Pick<NodeDefinitionSpec, "nodeKey">[],
  dependencyEdges: readonly DependencyEdgeSpec[],
  entryNodeKey: string,
): Map<string, ReadonlySet<string>> | null {
  const nodeKeys = new Set(nodeDefinitions.map((node) => node.nodeKey));
  if (!nodeKeys.has(entryNodeKey)) return null;

  // Reuses `tryComputeTopoRanks` purely as a cycle/malformed-edge check —
  // a real dominator tree requires an acyclic graph reachable from a
  // single root, and this file's compiled graphs are always acyclic by
  // construction (a `loop` node's own repeated iteration is never modeled
  // as a back-edge here — see `compile-node-definitions.ts`), so a cycle
  // here only ever means a hand-edited/malformed spec.
  if (tryComputeTopoRanks(nodeDefinitions, dependencyEdges) === null) {
    return null;
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const key of nodeKeys) {
    outgoing.set(key, []);
    incoming.set(key, []);
  }
  for (const edge of dependencyEdges) {
    outgoing.get(edge.fromNodeKey)?.push(edge.toNodeKey);
    incoming.get(edge.toNodeKey)?.push(edge.fromNodeKey);
  }

  // Nodes reachable from the entry point via outgoing edges — only these
  // matter for dominance (see this function's own doc comment).
  const reachable = new Set<string>([entryNodeKey]);
  const queue: string[] = [entryNodeKey];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of outgoing.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  const dom = new Map<string, Set<string>>();
  dom.set(entryNodeKey, new Set([entryNodeKey]));
  for (const key of reachable) {
    if (key !== entryNodeKey) dom.set(key, new Set(reachable));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const key of reachable) {
      if (key === entryNodeKey) continue;

      let intersection: Set<string> | null = null;
      for (const predecessor of incoming.get(key) ?? []) {
        if (!reachable.has(predecessor)) continue;
        const predecessorDom = dom.get(predecessor);
        if (!predecessorDom) continue;
        if (intersection === null) {
          intersection = new Set(predecessorDom);
          continue;
        }
        for (const candidate of intersection) {
          if (!predecessorDom.has(candidate)) intersection.delete(candidate);
        }
      }

      const nextDom = intersection ?? new Set<string>();
      nextDom.add(key);

      const currentDom = dom.get(key);
      if (
        !currentDom ||
        currentDom.size !== nextDom.size ||
        [...currentDom].some((item) => !nextDom.has(item))
      ) {
        dom.set(key, nextDom);
        changed = true;
      }
    }
  }

  return dom;
}
