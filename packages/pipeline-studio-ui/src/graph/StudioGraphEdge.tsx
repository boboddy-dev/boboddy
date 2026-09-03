import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { StudioEdge } from "./studio-graph-types";
import { highestSeverity, severityColor } from "./studio-graph-visuals";

/**
 * The studio's custom edge renderer — registered as `edgeTypes.default` in
 * `PipelineGraphView.tsx`. Renders the same bezier path React Flow's own
 * built-in default edge uses, colored by `highestSeverity(data.issues)` —
 * reuses the exact same `severityColor` helper `StudioGraphNode.tsx` uses,
 * so an edge carrying a `signal-binding` issue reads with the same red/amber
 * vocabulary as an issue-carrying node.
 */
export function StudioGraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  label,
  data,
}: EdgeProps<StudioEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const severity = highestSeverity(data?.issues ?? []);

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      label={label}
      labelX={labelX}
      labelY={labelY}
      style={severity ? { stroke: severityColor(severity), strokeWidth: 2 } : undefined}
    />
  );
}
