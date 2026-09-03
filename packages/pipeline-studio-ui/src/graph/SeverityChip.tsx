import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import { severityColor } from "./studio-graph-visuals";

/**
 * A small colored pill labeling an issue's own severity ("ERROR"/"WARNING"/
 * "INFO", via CSS `text-transform: uppercase` — the value itself stays
 * lowercase, matching `DefinitionValidationIssue.severity`). Shown next to
 * every issue row in both the pipeline-level issues list (`App.tsx`'s
 * `IssueRow`) and the per-node detail panel (`NodeDetailPanel.tsx`'s
 * `IssueMessageRow`), so a reader can tell at a glance whether an issue
 * blocks a push (`error`) or is just worth awareness (`warning`/`info`)
 * without reading the message text. Reuses `severityColor` as the chip's
 * background, so its color always matches the issue's border/node-badge
 * color elsewhere in the studio.
 */
export function SeverityChip({
  severity,
}: {
  severity: DefinitionValidationIssue["severity"];
}) {
  return (
    <span
      className="studio-severity-chip"
      style={{ backgroundColor: severityColor(severity) }}
    >
      {severity}
    </span>
  );
}
