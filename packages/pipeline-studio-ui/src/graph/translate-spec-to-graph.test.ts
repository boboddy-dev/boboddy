import { describe, expect, test } from "bun:test";
import type {
  DependencyEdgeSpec,
  NodeDefinitionSpec,
  PipelineDefinitionSpec,
} from "@boboddy/sdk/definitions/pipelines";
import type { StepDefinitionSpec } from "@boboddy/sdk/definitions/steps";
import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import { translatePipelineToSnapshot, translateSpecToGraph } from "./translate-spec-to-graph";

// Exported for `translate-spec-to-graph-shape.test.ts` (split out of this
// file to stay under the repo's `max-lines` lint rule) to reuse rather than
// duplicate.
export function pipeline(
  nodeDefinitions: NodeDefinitionSpec[],
  dependencyEdges: DependencyEdgeSpec[],
): PipelineDefinitionSpec {
  return {
    key: "review-pr",
    name: "Review PR",
    description: null,
    version: 1,
    status: "active",
    entryNodeKey: nodeDefinitions[0]?.nodeKey ?? "review-pr",
    nodeDefinitions,
    dependencyEdges,
  };
}

export const ADVANCEMENT_POLICY = {
  rulesJson: { rules: [] },
  defaultEventType: "continue" as const,
  defaultEventParamsJson: null,
  allowedEventTypes: ["continue" as const],
};

export function stepNode(
  overrides: Partial<Extract<NodeDefinitionSpec, { kind: "step" }>> & {
    nodeKey: string;
    stepKey: string;
    stepName: string;
  },
): NodeDefinitionSpec {
  return {
    kind: "step",
    stepDescription: null,
    inputBindingsJson: {},
    timeoutSeconds: null,
    advancementPolicyDefinition: ADVANCEMENT_POLICY,
    computedSignalDefinitions: [],
    ...overrides,
  };
}

export const ANALYZE: NodeDefinitionSpec = stepNode({
  nodeKey: "analyze",
  stepKey: "analyze-step",
  stepName: "Analyze",
});
export const ROUTE: NodeDefinitionSpec = {
  nodeKey: "routeBySeverity",
  kind: "choice",
  choices: [{ conditionJson: { fact: "severity", operator: "equal", value: "critical" }, targetNodeKey: "pageOncall" }],
  default: "summarize",
};
export const PAGE_ONCALL: NodeDefinitionSpec = stepNode({
  nodeKey: "pageOncall",
  stepKey: "page-oncall-step",
  stepName: "Page Oncall",
});
export const SUMMARIZE: NodeDefinitionSpec = stepNode({
  nodeKey: "summarize",
  stepKey: "summarize-step",
  stepName: "Summarize",
  inputBindingsJson: {
    diff: { source: "step_signal", stepKey: "analyze", signalKey: "diff" },
  },
});

export const EDGES: DependencyEdgeSpec[] = [
  { fromNodeKey: "analyze", toNodeKey: "routeBySeverity" },
  { fromNodeKey: "routeBySeverity", toNodeKey: "pageOncall" },
  { fromNodeKey: "routeBySeverity", toNodeKey: "summarize" },
  { fromNodeKey: "pageOncall", toNodeKey: "summarize" },
];

export function stepSpec(
  overrides: Partial<StepDefinitionSpec> & { key: string },
): StepDefinitionSpec {
  return {
    name: overrides.key,
    description: null,
    version: 1,
    kind: "user_defined",
    status: "active",
    prompt: null,
    inputSchemaJson: null,
    resultSchemaJson: null,
    signalExtractorDefinitions: [],
    opencodeMcpJson: null,
    opencodePluginJson: null,
    healthChecksJson: null,
    ...overrides,
  };
}

describe("translateSpecToGraph — mapping", () => {
  test("maps every node and edge, with a stable label per kind", () => {
    const spec = pipeline([ANALYZE, ROUTE, PAGE_ONCALL, SUMMARIZE], EDGES);

    const { nodes, edges } = translateSpecToGraph(spec, []);

    expect(nodes.map((n) => n.id).sort()).toEqual(
      ["analyze", "pageOncall", "routeBySeverity", "summarize"].sort(),
    );
    expect(edges).toHaveLength(EDGES.length);
    expect(edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(
      EDGES.map((e) => `${e.fromNodeKey}->${e.toNodeKey}`).sort(),
    );

    const analyzeNode = nodes.find((n) => n.id === "analyze");
    expect(analyzeNode?.data.label).toBe("Analyze");
    expect(analyzeNode?.data.kind).toBe("step");

    // A `choice` node has no `stepName` — falls back to its own node key.
    const routeNode = nodes.find((n) => n.id === "routeBySeverity");
    expect(routeNode?.data.label).toBe("routeBySeverity");
  });

  test("lays out every node with a distinct, non-origin position", () => {
    const spec = pipeline([ANALYZE, ROUTE, PAGE_ONCALL, SUMMARIZE], EDGES);

    const { nodes } = translateSpecToGraph(spec, []);

    const positions = nodes.map(
      (n) => `${String(n.position.x)},${String(n.position.y)}`,
    );
    expect(new Set(positions).size).toBe(nodes.length);

    // Top-to-bottom layout: analyze (rank 0) sits strictly above summarize
    // (a later rank), since dagre's `rankdir: "TB"` increases y with rank.
    const analyzeY = nodes.find((n) => n.id === "analyze")?.position.y ?? 0;
    const summarizeY = nodes.find((n) => n.id === "summarize")?.position.y ?? 0;
    expect(summarizeY).toBeGreaterThan(analyzeY);
  });

  test("a pipeline with no edges still lays out without throwing", () => {
    const spec = pipeline([ANALYZE], []);

    const { nodes, edges } = translateSpecToGraph(spec, []);

    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });
});

describe("translateSpecToGraph — issue attachment", () => {
  test("attaches a node-scoped issue (route-target) to its node", () => {
    const spec = pipeline([ANALYZE, ROUTE, PAGE_ONCALL, SUMMARIZE], EDGES);
    const issue: DefinitionValidationIssue = {
      check: "route-target",
      severity: "error",
      pipelineKey: "review-pr",
      nodeKey: "pageOncall",
      message: "routes to an unknown pipeline",
    };

    const { nodes, edges } = translateSpecToGraph(spec, [issue]);

    expect(nodes.find((n) => n.id === "pageOncall")?.data.issues).toEqual([
      issue,
    ]);
    for (const edge of edges) {
      expect(edge.data?.issues).toEqual([]);
    }
  });

  test("attaches a signal-binding issue to the direct edge it names", () => {
    const spec = pipeline([ANALYZE, ROUTE, PAGE_ONCALL, SUMMARIZE], EDGES);
    // pageOncall -> summarize IS a direct edge in this fixture.
    const issue: DefinitionValidationIssue = {
      check: "signal-binding",
      severity: "error",
      pipelineKey: "review-pr",
      nodeKey: "summarize",
      targetNodeKey: "pageOncall",
      message: "binds a signal pageOncall never declares",
    };

    const { nodes, edges } = translateSpecToGraph(spec, [issue]);

    const targetEdge = edges.find(
      (e) => e.source === "pageOncall" && e.target === "summarize",
    );
    expect(targetEdge?.data?.issues).toEqual([issue]);
    expect(nodes.find((n) => n.id === "summarize")?.data.issues).toEqual([]);
  });

  test("falls back to the consuming node when nodeKey/targetNodeKey aren't a direct edge", () => {
    const spec = pipeline([ANALYZE, ROUTE, PAGE_ONCALL, SUMMARIZE], EDGES);
    // analyze -> summarize is NOT a direct edge (analyze -> routeBySeverity -> ... -> summarize).
    const issue: DefinitionValidationIssue = {
      check: "signal-binding",
      severity: "error",
      pipelineKey: "review-pr",
      nodeKey: "summarize",
      targetNodeKey: "analyze",
      message: "binds a signal analyze never declares",
    };

    const { nodes, edges } = translateSpecToGraph(spec, [issue]);

    expect(nodes.find((n) => n.id === "summarize")?.data.issues).toEqual([
      issue,
    ]);
    for (const edge of edges) {
      expect(edge.data?.issues).toEqual([]);
    }
  });

  test("ignores issues scoped to a different pipeline", () => {
    const spec = pipeline([ANALYZE], []);
    const issue: DefinitionValidationIssue = {
      check: "route-target",
      severity: "error",
      pipelineKey: "some-other-pipeline",
      nodeKey: "analyze",
      message: "not about this pipeline",
    };

    const { nodes } = translateSpecToGraph(spec, [issue]);

    expect(nodes[0]?.data.issues).toEqual([]);
  });

  test("ignores step-only issues, which carry no nodeKey to attach to", () => {
    const spec = pipeline([ANALYZE], []);
    const issue: DefinitionValidationIssue = {
      check: "signal-source-path",
      severity: "error",
      message: "sourcePath never resolves",
    };

    const { nodes } = translateSpecToGraph(spec, [issue]);

    expect(nodes[0]?.data.issues).toEqual([]);
  });
});

describe("translatePipelineToSnapshot", () => {
  test("carries the pipeline's own key and name alongside its graph", () => {
    const spec = pipeline([ANALYZE], []);

    const snapshot = translatePipelineToSnapshot(spec, []);

    expect(snapshot.key).toBe("review-pr");
    expect(snapshot.name).toBe("Review PR");
    expect(snapshot.nodes).toHaveLength(1);
  });
});

