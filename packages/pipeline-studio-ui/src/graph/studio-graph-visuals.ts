// Pure, React-free presentation logic shared by `StudioGraphNode.tsx` and
// `StudioGraphEdge.tsx` — kept in a plain `.ts` file (rather than inside
// either component) so `bun:test` can import and exercise it directly,
// without a JSX/React-DOM test environment. See this package's `package.json`
// (`"test": "bun test src"`) and Phase 4's plan note re: not adding a new
// test framework to this package.
import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import type { StudioNodeShape } from "./studio-graph-types";

/**
 * The highest-severity issue among `issues`, or `null` when there are none —
 * `"error"` wins over `"warning"` wins over `"info"`, regardless of
 * order/count. Shared by node border color, edge color, and (indirectly) the
 * issue-count badge's own color.
 */
export function highestSeverity(
  issues: readonly DefinitionValidationIssue[],
): "error" | "warning" | "info" | null {
  let sawWarning = false;
  let sawInfo = false;
  for (const issue of issues) {
    if (issue.severity === "error") return "error";
    if (issue.severity === "warning") sawWarning = true;
    else sawInfo = true;
  }
  if (sawWarning) return "warning";
  return sawInfo ? "info" : null;
}

/**
 * The color for a given severity (or `null`, meaning "no issues") — reuses
 * this package's existing hand-rolled palette from `index-html-template.ts`:
 * `#b00020` (error-red, already used for `.studio-status-error` /
 * `.studio-option-broken` / the broken-pipeline dialog's heading) and
 * `#b34700` (warning-amber, already used for `.studio-issue-check`).
 * `#0969da` (info-blue) is new here — this package's palette had no
 * existing "informational, not error-adjacent" color to reuse. Neutral
 * falls back to the same light-gray border color React Flow's own default
 * node uses, so an issue-free node doesn't stand out from today's baseline.
 */
export function severityColor(
  severity: "error" | "warning" | "info" | null,
): string {
  switch (severity) {
    case "error":
      return "#b00020";
    case "warning":
      return "#b34700";
    case "info":
      return "#0969da";
    case null:
      return "#1a192b1a";
  }
}

/**
 * "N in · M out" counts for a node's `shape` — `null` when the shape carries
 * no meaningful counts to show (`kind: "none"`: `choice`/`succeed`/`fail`/
 * `cohortGate` nodes, or a `step`/`parallel` node whose `stepKey` didn't
 * resolve against the `steps` batch). Showing "0 in · 0 out" for those would
 * read as "this step declares zero fields," which is a different, false
 * claim from "this node has no step-derived shape at all" — see
 * `StudioNodeShape`'s own doc comment in `studio-graph-types.ts`.
 *
 * For `"parallel"`, `in` sums every branch's own `inputFields.length` (a
 * branch with `inputFields: null` — its own `stepKey` unresolved — 
 * contributes 0, not a fallback that would silently miscount); `"parallel"`
 * nodes have no `out` count of their own (only single-step nodes carry
 * `outputSignals` — see `StudioNodeShape`'s doc comment), so `out` is always
 * `0` for that kind.
 */
export function nodeInOutCounts(
  shape: StudioNodeShape,
): { inCount: number; outCount: number } | null {
  switch (shape.kind) {
    case "step":
      return { inCount: shape.inputFields.length, outCount: shape.outputSignals.length };
    case "parallel":
      return {
        inCount: shape.branches.reduce(
          (sum, branch) => sum + (branch.inputFields?.length ?? 0),
          0,
        ),
        outCount: 0,
      };
    case "none":
      return null;
  }
}

/** Formats `nodeInOutCounts`'s result as the literal "N in · M out" string. */
export function formatInOutCounts(counts: { inCount: number; outCount: number }): string {
  return `${String(counts.inCount)} in · ${String(counts.outCount)} out`;
}
