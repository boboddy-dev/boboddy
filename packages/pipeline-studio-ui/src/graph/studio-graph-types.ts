import type { Edge, Node } from "@xyflow/react";
import type {
  DefinitionValidationIssue,
  SchemaType,
} from "@boboddy/sdk/definitions/validation";
import type { NodeDefinitionKind } from "@boboddy/sdk/definitions/pipelines";
import type { BrokenPipeline } from "@boboddy/sdk/push";

// `Node`/`Edge` are imported `type`-only (see the top-level comment in
// `translate-spec-to-graph.ts`), so this file — and everything that only
// imports types from it — never pulls the real `@xyflow/react` runtime (React
// component tree, `@xyflow/system`, `classcat`, ...) into a non-browser bundle
// such as `@boboddy/worker`'s local studio server.

/**
 * One `additionalInput` field on a consumer step, as shown on its node.
 * Deliberately excludes the two always-auto-bound `workItemTitle`/
 * `workItemDescription` fields (see `translate-spec-to-graph.ts`'s
 * `stepInputFields`) — those are fixed plumbing present on every working
 * node, not step-declared shape, and would make every node's field count
 * off by two with no useful signal.
 */
export type StudioNodeInputField = {
  name: string;
  type: SchemaType;
  required: boolean;
  /**
   * A short, human-readable description of what this field is bound to
   * (e.g. `signal "diff" of analyze`), or `null` when `inputBindingsJson`
   * has no entry for this field name at all.
   */
  boundTo: string | null;
};

/** One declared output signal on a consumer step, as shown on its node. */
export type StudioNodeOutputSignal = {
  key: string;
  type: SchemaType;
  required: boolean;
};

/**
 * One `parallel` node's own branch — its own step's input shape plus the
 * issues scoped to that specific branch (`DefinitionValidationIssue.branchKey`
 * — see `validation-issue.ts`).
 *
 * `inputFields` is `null` (not `[]`) when the branch's own `stepKey` doesn't
 * resolve against the `steps` batch passed to `translateSpecToGraph` — see
 * `StudioNodeShape`'s own doc comment for why an empty array is the wrong
 * fallback for "shape unknown."
 */
export type StudioParallelBranchShape = {
  key: string;
  label: string;
  inputFields: StudioNodeInputField[] | null;
  issues: DefinitionValidationIssue[];
};

/**
 * A node's step-derived shape, discriminated by `kind`:
 *
 * - `"step"` — a single-step node (`step`/`fanOut`/`loop`, all of which
 *   run exactly one step template): the consumer step's `additionalInput`
 *   fields, declared output signals, and raw result schema.
 * - `"parallel"` — a `parallel` node's own branches, each independently
 *   resolved against its own `stepKey`.
 * - `"none"` — every other node kind (`cohortGate`/`choice`/`succeed`/
 *   `fail`), and the `"step"`/`"parallel"` cases when the node's
 *   `stepKey` doesn't resolve against the `steps` batch passed to
 *   `translateSpecToGraph` (step not collected in this batch) — chosen
 *   over fabricating empty arrays, which would look like a real,
 *   zero-field step rather than "shape unknown."
 */
export type StudioNodeShape =
  | {
      kind: "step";
      inputFields: StudioNodeInputField[];
      outputSignals: StudioNodeOutputSignal[];
      resultSchemaJson: Record<string, unknown> | null;
    }
  | { kind: "parallel"; branches: StudioParallelBranchShape[] }
  | { kind: "none" };

/** Per-node data the designer renders inline next to the node itself. */
export type StudioNodeData = {
  /** Human label — the step's own name, falling back to its node key. */
  label: string;
  kind: NodeDefinitionKind;
  stepKey?: string;
  /** Validation issues attached to this node — see `translateSpecToGraph`. */
  issues: DefinitionValidationIssue[];
  /** This node's step-derived shape — see `StudioNodeShape`. */
  shape: StudioNodeShape;
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
