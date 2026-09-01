import type { Edge, Node } from "@xyflow/react";
import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import type { NodeDefinitionKind } from "@boboddy/sdk/definitions/pipelines";
import type { BrokenPipeline } from "@boboddy/sdk/push";

// `Node`/`Edge` are imported `type`-only (see the top-level comment in
// `translate-spec-to-graph.ts`), so this file — and everything that only
// imports types from it — never pulls the real `@xyflow/react` runtime (React
// component tree, `@xyflow/system`, `classcat`, ...) into a non-browser bundle
// such as `@boboddy/worker`'s local studio server.

/** Per-node data the designer renders inline next to the node itself. */
export type StudioNodeData = {
  /** Human label — the step's own name, falling back to its node key. */
  label: string;
  kind: NodeDefinitionKind;
  stepKey?: string;
  /** Validation issues attached to this node — see `translateSpecToGraph`. */
  issues: DefinitionValidationIssue[];
};

/** Per-edge data — an edge only ever carries `signal-binding` issues. */
export type StudioEdgeData = {
  issues: DefinitionValidationIssue[];
};

export type StudioNode = Node<StudioNodeData>;
export type StudioEdge = Edge<StudioEdgeData>;

/** One pipeline's translated, laid-out graph. */
export type PipelineGraphSnapshot = {
  key: string;
  name: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
};

/**
 * The SSE stream's payload shape (see `docs/research/flat-pipeline-sdk-and-visual-designer.md`
 * §10). One entry per pipeline collected from `.boboddy/pipeline-builder` —
 * generalized from the plan's single-graph wording because a builder
 * directory commonly holds more than one pipeline file; the client picks
 * which one to render (see `App.tsx`).
 *
 * `validationIssues` carries the FULL, unfiltered issue list, not just the
 * ones `translateSpecToGraph` managed to attach to a node/edge — a
 * step-scoped issue (`signal-source-path`, `health-check-*`) has no
 * `nodeKey` at all and can never attach anywhere in the graph, so it would
 * otherwise vanish from the UI entirely. See `compute-studio-snapshot.ts`.
 */
export type StudioSnapshot =
  | {
      status: "ok";
      pipelines: PipelineGraphSnapshot[];
      /**
       * Pipelines that failed to import/compile — each one isolated to its
       * own source file, so the rest of `pipelines` above still renders
       * normally. See `collectDefinitionsFromDirectoryTolerant`.
       */
      brokenPipelines: readonly BrokenPipeline[];
      validationIssues: DefinitionValidationIssue[];
      collectedAt: string;
    }
  | {
      status: "error";
      message: string;
      collectedAt: string;
    };
