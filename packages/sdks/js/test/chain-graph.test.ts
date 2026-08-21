import { describe, expect, test } from "bun:test";
import {
  orderChainNodeDefinitions,
  tryOrderChainNodeDefinitions,
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

function node(nodeKey: string): NodeDefinitionSpec {
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

describe("tryOrderChainNodeDefinitions", () => {
  test("orders a simple chain by walking edges from the root", () => {
    const nodes = [node("c"), node("a"), node("b")];
    const edges = [edge("a", "b"), edge("b", "c")];

    const ordered = tryOrderChainNodeDefinitions(nodes, edges);

    expect(ordered?.map((n) => n.nodeKey)).toEqual(["a", "b", "c"]);
  });

  test("returns the single node unordered when there are no edges", () => {
    const nodes = [node("only")];

    const ordered = tryOrderChainNodeDefinitions(nodes, []);

    expect(ordered?.map((n) => n.nodeKey)).toEqual(["only"]);
  });

  test("returns an empty array for an empty node list with no edges", () => {
    // Vacuously a valid (empty) chain.
    const ordered = tryOrderChainNodeDefinitions([], []);
    expect(ordered).toEqual([]);
  });

  test("returns null when there are multiple roots", () => {
    const nodes = [node("a"), node("b"), node("c")];
    // "a" and "b" both have no incoming edge — two roots.
    const edges = [edge("a", "c")];

    expect(tryOrderChainNodeDefinitions(nodes, edges)).toBeNull();
  });

  test("returns null when a node has more than one outgoing edge (fan-out)", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b"), edge("a", "c")];

    expect(tryOrderChainNodeDefinitions(nodes, edges)).toBeNull();
  });

  test("returns null when a node has more than one incoming edge (fan-in)", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "c"), edge("b", "c")];

    expect(tryOrderChainNodeDefinitions(nodes, edges)).toBeNull();
  });

  test("returns null for a cycle", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b"), edge("b", "a")];

    expect(tryOrderChainNodeDefinitions(nodes, edges)).toBeNull();
  });

  test("returns null for a disconnected node", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b")];

    expect(tryOrderChainNodeDefinitions(nodes, edges)).toBeNull();
  });
});

describe("orderChainNodeDefinitions", () => {
  test("returns the ordered chain when structurally valid", () => {
    const nodes = [node("b"), node("a")];
    const edges = [edge("a", "b")];

    expect(orderChainNodeDefinitions(nodes, edges).map((n) => n.nodeKey)).toEqual([
      "a",
      "b",
    ]);
  });

  test("throws a descriptive error for a malformed graph", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b")];

    expect(() => orderChainNodeDefinitions(nodes, edges)).toThrow();
  });
});
