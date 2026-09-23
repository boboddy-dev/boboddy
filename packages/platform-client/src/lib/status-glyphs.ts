import type { PipelineStepRunStatus } from "./api-types";

/**
 * Single-character status glyphs for the step rail (decision 8's "one line
 * per step (status glyph)"). No existing glyph convention was found
 * elsewhere in the CLI (`apps/cli/src/lib/reporter*.ts` uses `@clack/prompts`
 * spinners, not a fixed glyph table) or in the Next.js UI (`STATUS_COLOR_KEY`
 * in `apps/next/components/pipeline-graph/pipeline-graph-node-status.ts`
 * maps status to a *color*, not a character) — this table is a new choice
 * for this package, kept small and legible in a monospace terminal:
 *
 *   ✓ satisfied            — succeeded
 *   ✗ unsatisfied           — failed a policy check
 *   ● running               — in flight
 *   ○ queued / pending      — not started yet
 *   ‼ blocked               — waiting on a human decision
 *   ⏱ timeout               — blew its execution deadline
 *   ⚠ abandoned             — lost its worker lease
 *   ⊘ cancelled             — deliberately stopped
 *
 * Typed as `Record<PipelineStepRunStatus, string>` so the compiler enforces
 * every status has an entry — if `PipelineStepRunStatus` ever grows, this
 * table fails to typecheck until updated, rather than silently falling back
 * at runtime.
 */
const STATUS_GLYPHS: Record<PipelineStepRunStatus, string> = {
  satisfied: "✓",
  unsatisfied: "✗",
  running: "●",
  queued: "○",
  pending: "○",
  blocked: "‼",
  timeout: "⏱",
  abandoned: "⚠",
  cancelled: "⊘",
};

export function statusGlyph(status: PipelineStepRunStatus): string {
  return STATUS_GLYPHS[status];
}
