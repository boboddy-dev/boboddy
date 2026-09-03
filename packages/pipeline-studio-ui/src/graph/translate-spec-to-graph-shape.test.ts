// Split out of `translate-spec-to-graph.test.ts` (Phase 3/7 of
// docs/plans/pipeline-studio-shapes-and-binding-errors.md) to stay under the
// repo's `max-lines` lint rule — covers node `shape` resolution and
// severity flow-through specifically; mapping/issue-attachment/snapshot
// coverage stays in the sibling file, whose fixtures this reuses.
import { describe, expect, test } from "bun:test";
import type {
  NodeDefinitionSpec,
} from "@boboddy/sdk/definitions/pipelines";
import type { StepDefinitionSpec } from "@boboddy/sdk/definitions/steps";
import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import { translateSpecToGraph } from "./translate-spec-to-graph";
import {
  ANALYZE,
  EDGES,
  PAGE_ONCALL,
  ROUTE,
  SUMMARIZE,
  pipeline,
  stepNode,
  stepSpec,
} from "./translate-spec-to-graph.test";

describe("translateSpecToGraph — shape", () => {
  const ANALYZE_STEP: StepDefinitionSpec = stepSpec({
    key: "analyze-step",
    inputSchemaJson: {
      type: "object",
      properties: {
        repoUrl: { type: "string" },
        maxFiles: { type: "number" },
      },
      required: ["repoUrl"],
      additionalProperties: false,
    },
    resultSchemaJson: {
      type: "object",
      properties: { diff: { type: "string" } },
      additionalProperties: false,
    },
    signalExtractorDefinitions: [
      {
        key: "diff",
        sourcePath: "diff",
        type: "string",
        required: true,
        availableWhenResultStatusIn: null,
      },
    ],
  });

  const ANALYZE_BOUND: NodeDefinitionSpec = stepNode({
    nodeKey: "analyze",
    stepKey: "analyze-step",
    stepName: "Analyze",
    inputBindingsJson: {
      repoUrl: { source: "pipeline_input", path: "repo" },
    },
  });

  test("resolves a step node's inputFields/outputSignals/resultSchemaJson from its step", () => {
    const spec = pipeline([ANALYZE_BOUND], []);

    const { nodes } = translateSpecToGraph(spec, [], [ANALYZE_STEP]);

    expect(nodes.find((n) => n.id === "analyze")?.data.shape).toEqual({
      kind: "step",
      inputFields: [
        {
          name: "repoUrl",
          type: "string",
          required: true,
          boundTo: 'pipeline input "repo"',
        },
        {
          name: "maxFiles",
          type: "number",
          required: false,
          boundTo: null,
        },
      ],
      outputSignals: [{ key: "diff", type: "string", required: true }],
      resultSchemaJson: ANALYZE_STEP.resultSchemaJson,
    });
  });

  test("falls back to {kind: 'none'} for a node kind that never runs a step (choice)", () => {
    const spec = pipeline([ROUTE], []);

    const { nodes } = translateSpecToGraph(spec, [], [ANALYZE_STEP]);

    expect(nodes[0]?.data.shape).toEqual({ kind: "none" });
  });

  test("falls back to {kind: 'none'} when a working node's stepKey isn't in the steps batch", () => {
    const spec = pipeline([ANALYZE_BOUND], []);

    // No steps passed at all — "analyze-step" doesn't resolve.
    const { nodes } = translateSpecToGraph(spec, []);

    expect(nodes.find((n) => n.id === "analyze")?.data.shape).toEqual({
      kind: "none",
    });
  });

  describe("a parallel node's per-branch shape and issues", () => {
    const LINT_STEP: StepDefinitionSpec = stepSpec({
      key: "lint-step",
      inputSchemaJson: {
        type: "object",
        properties: { strict: { type: "boolean" } },
        required: ["strict"],
        additionalProperties: false,
      },
    });

    const TEST_STEP: StepDefinitionSpec = stepSpec({
      key: "test-step",
      inputSchemaJson: {
        type: "object",
        properties: { target: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    });

    const VERIFY: NodeDefinitionSpec = {
      nodeKey: "verify",
      kind: "parallel",
      branches: {
        lint: {
          stepKey: "lint-step",
          stepName: "Lint",
          stepDescription: null,
          inputBindingsJson: {},
        },
        test: {
          stepKey: "test-step",
          stepName: "Test",
          stepDescription: null,
          inputBindingsJson: {
            target: { source: "work_item", field: "title" },
          },
        },
        // References a step not present in this batch, exercising the same
        // per-branch {kind: 'none'}-equivalent (`inputFields: null`)
        // fallback a working node uses.
        unresolved: {
          stepKey: "missing-step",
          stepName: "Missing",
          stepDescription: null,
          inputBindingsJson: {},
        },
      },
    };

    const lintIssue: DefinitionValidationIssue = {
      check: "unbound-required-input",
      severity: "error",
      pipelineKey: "review-pr",
      nodeKey: "verify",
      branchKey: "lint",
      message: 'branch "lint" runs step "lint-step", which requires input "strict"',
    };
    const testIssue: DefinitionValidationIssue = {
      check: "binding-type-mismatch",
      severity: "warning",
      pipelineKey: "review-pr",
      nodeKey: "verify",
      branchKey: "test",
      message: 'branch "test" binds input "target" to a type that disagrees',
    };

    test("resolves each branch's own inputFields, independent of the others", () => {
      const spec = pipeline([VERIFY], []);

      const { nodes } = translateSpecToGraph(
        spec,
        [lintIssue, testIssue],
        [LINT_STEP, TEST_STEP],
      );

      const shape = nodes.find((n) => n.id === "verify")?.data.shape;
      expect(shape?.kind).toBe("parallel");
      if (shape?.kind !== "parallel") throw new Error("expected parallel shape");

      const lintBranch = shape.branches.find((b) => b.key === "lint");
      expect(lintBranch?.inputFields).toEqual([
        { name: "strict", type: "boolean", required: true, boundTo: null },
      ]);

      const testBranch = shape.branches.find((b) => b.key === "test");
      expect(testBranch?.inputFields).toEqual([
        {
          name: "target",
          type: "string",
          required: false,
          boundTo: "work_item.title",
        },
      ]);

      const unresolvedBranch = shape.branches.find((b) => b.key === "unresolved");
      expect(unresolvedBranch?.inputFields).toBeNull();
    });

    test("filters each branch's issues to only that branch's own branchKey", () => {
      const spec = pipeline([VERIFY], []);

      const { nodes } = translateSpecToGraph(
        spec,
        [lintIssue, testIssue],
        [LINT_STEP, TEST_STEP],
      );

      const node = nodes.find((n) => n.id === "verify");
      // Node-level issues still aggregate across every branch.
      expect(node?.data.issues).toEqual([lintIssue, testIssue]);

      const shape = node?.data.shape;
      if (shape?.kind !== "parallel") throw new Error("expected parallel shape");

      expect(shape.branches.find((b) => b.key === "lint")?.issues).toEqual([
        lintIssue,
      ]);
      expect(shape.branches.find((b) => b.key === "test")?.issues).toEqual([
        testIssue,
      ]);
      expect(shape.branches.find((b) => b.key === "unresolved")?.issues).toEqual(
        [],
      );
    });
  });
});

describe("translateSpecToGraph — severity flows through", () => {
  test("a warning-severity issue keeps its severity on the node it attaches to", () => {
    const spec = pipeline([ANALYZE], []);
    const issue: DefinitionValidationIssue = {
      check: "binding-type-mismatch",
      severity: "warning",
      pipelineKey: "review-pr",
      nodeKey: "analyze",
      message: "declared type disagrees with the bound source's type",
    };

    const { nodes } = translateSpecToGraph(spec, [issue]);

    expect(nodes.find((n) => n.id === "analyze")?.data.issues).toEqual([
      issue,
    ]);
    expect(
      nodes.find((n) => n.id === "analyze")?.data.issues[0]?.severity,
    ).toBe("warning");
  });

  test("an error-severity issue keeps its severity on the edge it attaches to", () => {
    const spec = pipeline([ANALYZE, ROUTE, PAGE_ONCALL, SUMMARIZE], EDGES);
    const issue: DefinitionValidationIssue = {
      check: "signal-binding",
      severity: "error",
      pipelineKey: "review-pr",
      nodeKey: "summarize",
      targetNodeKey: "pageOncall",
      message: "binds a signal pageOncall never declares",
    };

    const { edges } = translateSpecToGraph(spec, [issue]);

    const targetEdge = edges.find(
      (e) => e.source === "pageOncall" && e.target === "summarize",
    );
    expect(targetEdge?.data?.issues[0]?.severity).toBe("error");
  });
});
