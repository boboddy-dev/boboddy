import { describe, expect, test } from "bun:test";
import {
  tryComputeDominators,
  tryComputeTopoRanks,
  tryOrderNodeDefinitionsByTopoRank,
} from "../src/definitions/pipelines/chain-graph";
import type {
  DependencyEdgeSpec,
  NodeDefinitionSpec,
} from "../src/definitions/pipelines/define-pipeline";

const ADVANCEMENT_POLICY = {
  rulesJson: { rules: [] },
  defaultEventType: "continue" as const,
  defaultEventParamsJson: null,
  allowedEventTypes: ["continue" as const],
};

function node(
  nodeKey: string,
  kind: "step" | "choice" = "step",
): NodeDefinitionSpec {
  if (kind === "choice") {
    return { nodeKey, kind: "choice", choices: [], default: null };
  }
  return {
    nodeKey,
    kind: "step",
    stepKey: nodeKey,
    stepName: nodeKey,
    stepDescription: null,
    inputBindingsJson: {},
    timeoutSeconds: null,
    advancementPolicyDefinition: ADVANCEMENT_POLICY,
    computedSignalDefinitions: [],
  };
}

function edge(fromNodeKey: string, toNodeKey: string): DependencyEdgeSpec {
  return { fromNodeKey, toNodeKey };
}

describe("tryComputeTopoRanks", () => {
  test.concurrent("ranks a simple chain by walking edges from the root", () => {
    const nodes = [node("c"), node("a"), node("b")];
    const edges = [edge("a", "b"), edge("b", "c")];

    const ranks = tryComputeTopoRanks(nodes, edges);

    expect(ranks?.get("a")).toBe(0);
    expect(ranks?.get("b")).toBe(1);
    expect(ranks?.get("c")).toBe(2);
  });

  test.concurrent("ranks a branching graph (two choice targets converging)", () => {
    // choice -> { a, b } -> shared -- both a and b feed into "shared".
    const nodes = [node("choice", "choice"), node("a"), node("b"), node("shared")];
    const edges = [
      edge("choice", "a"),
      edge("choice", "b"),
      edge("a", "shared"),
      edge("b", "shared"),
    ];

    const ranks = tryComputeTopoRanks(nodes, edges);

    expect(ranks?.get("choice")).toBe(0);
    expect(ranks?.get("a")).toBe(1);
    expect(ranks?.get("b")).toBe(1);
    // Longest-path-from-root: shared is reached via rank-1 nodes, so rank 2.
    expect(ranks?.get("shared")).toBe(2);
  });

  test.concurrent("returns an empty map for an empty node list with no edges", () => {
    const ranks = tryComputeTopoRanks([], []);
    expect(ranks?.size).toBe(0);
  });

  test.concurrent("returns null for a cycle", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b"), edge("b", "a")];

    expect(tryComputeTopoRanks(nodes, edges)).toBeNull();
  });

  test.concurrent("returns null when an edge references an unknown node key", () => {
    const nodes = [node("a")];
    const edges = [edge("a", "does-not-exist")];

    expect(tryComputeTopoRanks(nodes, edges)).toBeNull();
  });
});

describe("tryOrderNodeDefinitionsByTopoRank", () => {
  test.concurrent("orders nodes ascending by rank", () => {
    const nodes = [node("b"), node("a")];
    const edges = [edge("a", "b")];

    const ordered = tryOrderNodeDefinitionsByTopoRank(nodes, edges);

    expect(ordered?.map((n) => n.nodeKey)).toEqual(["a", "b"]);
  });

  test.concurrent("breaks ties by declaration order", () => {
    const nodes = [node("choice", "choice"), node("second"), node("first")];
    const edges = [edge("choice", "second"), edge("choice", "first")];

    const ordered = tryOrderNodeDefinitionsByTopoRank(nodes, edges);

    // "second" and "first" share rank 1; declaration order (as given in
    // `nodes`) breaks the tie.
    expect(ordered?.map((n) => n.nodeKey)).toEqual(["choice", "second", "first"]);
  });

  test.concurrent("returns null for a cycle", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b"), edge("b", "a")];

    expect(tryOrderNodeDefinitionsByTopoRank(nodes, edges)).toBeNull();
  });
});

describe("tryComputeDominators", () => {
  test.concurrent("the entry node dominates every reachable node", () => {
    // choice -> { a, b } -> shared -- both a and b feed into "shared".
    const nodes = [node("choice", "choice"), node("a"), node("b"), node("shared")];
    const edges = [
      edge("choice", "a"),
      edge("choice", "b"),
      edge("a", "shared"),
      edge("b", "shared"),
    ];

    const dominators = tryComputeDominators(nodes, edges, "choice");

    expect(dominators?.get("a")?.has("choice")).toBe(true);
    expect(dominators?.get("b")?.has("choice")).toBe(true);
    expect(dominators?.get("shared")?.has("choice")).toBe(true);
  });

  test.concurrent("every node dominates itself", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b")];

    const dominators = tryComputeDominators(nodes, edges, "a");

    expect(dominators?.get("a")?.has("a")).toBe(true);
    expect(dominators?.get("b")?.has("b")).toBe(true);
  });

  test.concurrent(
    "a node on only one branch of a choice does not dominate the shared target",
    () => {
      // choice -+-> pageOncall -+-> summarize
      //         +-------------------^
      const nodes = [
        node("choice", "choice"),
        node("pageOncall"),
        node("summarize"),
      ];
      const edges = [
        edge("choice", "pageOncall"),
        edge("choice", "summarize"),
        edge("pageOncall", "summarize"),
      ];

      const dominators = tryComputeDominators(nodes, edges, "choice");

      expect(dominators?.get("summarize")?.has("pageOncall")).toBe(false);
      expect(dominators?.get("summarize")?.has("choice")).toBe(true);
    },
  );

  test.concurrent("returns null when entryNodeKey names no node", () => {
    const nodes = [node("a")];
    const edges: DependencyEdgeSpec[] = [];

    expect(tryComputeDominators(nodes, edges, "does-not-exist")).toBeNull();
  });

  test.concurrent("returns null for a cycle", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b"), edge("b", "a")];

    expect(tryComputeDominators(nodes, edges, "a")).toBeNull();
  });

  test.concurrent("returns null when an edge references an unknown node key", () => {
    const nodes = [node("a")];
    const edges = [edge("a", "does-not-exist")];

    expect(tryComputeDominators(nodes, edges, "a")).toBeNull();
  });

  test.concurrent("omits nodes unreachable from the entry", () => {
    const nodes = [node("a"), node("b"), node("island")];
    const edges = [edge("a", "b")];

    const dominators = tryComputeDominators(nodes, edges, "a");

    expect(dominators?.has("island")).toBe(false);
  });
});
