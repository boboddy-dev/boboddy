import { Background, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { StudioEdge, StudioNode } from "./studio-graph-types";

/**
 * Renders one pipeline's translated graph via React Flow. Deliberately
 * app-agnostic — no `snapshot`/SSE/picker props here, those stay in the
 * consuming app (e.g. `App.tsx`'s studio server client). See
 * `docs/research/pipeline-graph-docs-catalog.md` §3, decision 4.
 */
export function PipelineGraphView({
  nodes,
  edges,
}: {
  nodes: StudioNode[];
  edges: StudioEdge[];
}) {
  return (
    <ReactFlowProvider>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
