import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StudioNode } from "./studio-graph-types";
import { formatInOutCounts, highestSeverity, nodeInOutCounts, severityColor } from "./studio-graph-visuals";

/**
 * The studio's custom node renderer — registered as `nodeTypes.default` in
 * `PipelineGraphView.tsx`, so every `StudioNode` (all built with an
 * undefined/`"default"` `type` by `translateSpecToGraph`) renders through
 * here instead of React Flow's own built-in default node.
 *
 * Shows, top to bottom: the step/node label (parity with React Flow's
 * built-in default node, which shows only `data.label`), a `kind` subtitle
 * (the plan's "existing label/kind" — `kind` gets its own line since it's a
 * different fact from the label and squeezing both onto one line reads as
 * cluttered), the "N in · M out" counts line (omitted entirely for
 * `shape.kind === "none"` — see `nodeInOutCounts`'s doc comment), and an
 * issue-count badge in the top-right corner when `data.issues` is non-empty.
 * The whole node's border is colored by `highestSeverity(data.issues)`.
 *
 * Top/bottom handles (`Position.Top`/`Position.Bottom`) match
 * `translateSpecToGraph`'s dagre layout, which always runs `rankdir: "TB"`.
 */
export function StudioGraphNode({ data, selected }: NodeProps<StudioNode>) {
  const severity = highestSeverity(data.issues);
  const counts = nodeInOutCounts(data.shape);

  return (
    <div
      className="studio-node"
      data-severity={severity ?? "none"}
      data-selected={selected ? "true" : undefined}
      style={{ borderColor: severityColor(severity) }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {data.issues.length > 0 ? (
        <span
          className="studio-node-badge"
          style={{ background: severityColor(severity) }}
          aria-label={`${String(data.issues.length)} validation issue(s)`}
        >
          {data.issues.length}
        </span>
      ) : null}
      <div className="studio-node-label">{data.label}</div>
      <div className="studio-node-kind">{data.kind}</div>
      {counts ? <div className="studio-node-counts">{formatInOutCounts(counts)}</div> : null}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
