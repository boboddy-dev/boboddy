import { Background, Controls, ReactFlow, ReactFlowProvider, type NodeTypes, type EdgeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { StudioGraphEdge } from "./StudioGraphEdge";
import { StudioGraphNode } from "./StudioGraphNode";
import type { StudioEdge, StudioNode } from "./studio-graph-types";

// Every `StudioNode`/`StudioEdge` `translateSpecToGraph` builds leaves `type`
// undefined, which React Flow resolves against the `"default"` key — see
// `NodeTypes`/`EdgeTypes` (`Record<string, ComponentType<...>>`) in
// `@xyflow/react`. Module-level constants (not recreated per render) since
// React Flow warns/re-renders excessively when `nodeTypes`/`edgeTypes` change
// identity between renders.
const nodeTypes: NodeTypes = { default: StudioGraphNode };
const edgeTypes: EdgeTypes = { default: StudioGraphEdge };

/**
 * Renders one pipeline's translated graph via React Flow. Deliberately
 * app-agnostic — no `snapshot`/SSE/picker props here, those stay in the
 * consuming app (e.g. `App.tsx`'s studio server client). See
 * `docs/research/pipeline-graph-docs-catalog.md` §3, decision 4.
 *
 * `onSelectNode`/`onDeselect` are plumbing for `App.tsx`'s lifted "selected
 * node" state (Phase 5) — `onSelectNode` fires on a node click, `onDeselect`
 * fires on a click anywhere on the empty canvas (React Flow's own
 * `onPaneClick`), the Phase 5 plan's "clicking empty graph canvas" affordance
 * for returning to the issues list. Both optional so any other caller
 * compiles unchanged.
 */
export function PipelineGraphView({
  nodes,
  edges,
  onSelectNode,
  onDeselect,
}: {
  nodes: StudioNode[];
  edges: StudioEdge[];
  onSelectNode?: (nodeKey: string) => void;
  onDeselect?: () => void;
}) {
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_event, node) => {
          onSelectNode?.(node.id);
        }}
        onPaneClick={() => {
          onDeselect?.();
        }}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
