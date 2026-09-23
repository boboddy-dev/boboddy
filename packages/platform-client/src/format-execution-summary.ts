import type {
  PipelineDefinition,
  PipelineExecution,
  PipelineExecutionAttempt,
  WorkItem,
} from "./lib/api-types";
import type { ExecutionStepItem } from "./lib/execution-step-items";
import { statusGlyph } from "./lib/status-glyphs";

export type FormatExecutionSummaryInput = {
  execution: PipelineExecution;
  workItem: WorkItem;
  pipelineDefinition: PipelineDefinition;
  attempt: PipelineExecutionAttempt;
  stepItems: readonly ExecutionStepItem[];
};

function formatTimestamp(value: string | null): string {
  return value ?? "—";
}

function latestAttemptNumber(execution: PipelineExecution): number | null {
  return execution.attempts.reduce<number | null>(
    (latest, candidate) =>
      latest === null || candidate.attemptNumber > latest
        ? candidate.attemptNumber
        : latest,
    null,
  );
}

function formatStepLine(item: ExecutionStepItem): string {
  const name = item.definition?.name ?? item.stepKey;
  if (item.stepRun === null) {
    return `  ○ ${item.stepKey}  ${name}  (not reached)`;
  }
  const glyph = statusGlyph(item.stepRun.status);
  const branchSuffix =
    item.runs.length > 1 ? ` (${String(item.runs.length)} branches)` : "";
  return `  ${glyph} ${item.stepKey}  ${name}  ${item.stepRun.status}${branchSuffix}`;
}

/**
 * Decision 8's default output: execution status, attempt info, one line per
 * step with a status glyph, plus hint lines pointing at `--step`/`--attempt`.
 * Pure/unit-testable: takes already-fetched, already-resolved data — no
 * fetching happens here.
 */
export function formatExecutionSummary(
  input: FormatExecutionSummaryInput,
): string {
  const { execution, workItem, pipelineDefinition, attempt, stepItems } =
    input;
  const lines: string[] = [];

  lines.push(`Pipeline execution ${execution.id}`);
  lines.push(
    `Work item: ${workItem.title}${workItem.url ? ` (${workItem.url})` : ""}`,
  );
  lines.push(
    `Pipeline: ${pipelineDefinition.name} (${pipelineDefinition.key})`,
  );
  lines.push(`Status: ${execution.status}`);
  lines.push("");

  lines.push(`Attempt ${String(attempt.attemptNumber)} — ${attempt.status}`);
  lines.push(`  Current step: ${attempt.currentStepKey ?? "none"}`);
  lines.push(`  Started:      ${formatTimestamp(attempt.startedAt)}`);
  lines.push(`  Completed:    ${formatTimestamp(attempt.completedAt)}`);
  lines.push("");

  lines.push("Steps:");
  if (stepItems.length === 0) {
    lines.push("  (no steps defined)");
  } else {
    for (const item of stepItems) {
      lines.push(formatStepLine(item));
    }
  }
  lines.push("");

  const latest = latestAttemptNumber(execution);
  lines.push("Next:");
  lines.push(
    "  --step <key>     inspect a step's status, output, and evaluation",
  );
  lines.push("  --log            fetch the step's logs (all streams)");
  lines.push("  --artifacts      list a step's artifacts with download URLs");
  if (latest !== null && latest !== attempt.attemptNumber) {
    lines.push(
      `  --attempt <n>    this is attempt ${String(attempt.attemptNumber)}; latest is ${String(latest)}`,
    );
  } else if (execution.attempts.length > 1) {
    lines.push(
      `  --attempt <n>    inspect a different attempt (${String(execution.attempts.length)} total)`,
    );
  }

  return lines.join("\n");
}
