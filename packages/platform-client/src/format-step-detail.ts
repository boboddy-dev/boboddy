import type { Artifact, StepExecution } from "./lib/api-types";
import type { ExecutionStepItem } from "./lib/execution-step-items";
import { statusGlyph } from "./lib/status-glyphs";

/** Cap on rendered JSON blobs (`outputJson`/`finalPayloadJson`/`resultJson`),
 * per the plan's Risks table ("outputJson/log content can still be large
 * even after truncation"). Picked as a generous-but-bounded size for a
 * terminal/agent to read in one shot; anything larger is truncated with an
 * explicit notice rather than silently cut off. */
export const MAX_JSON_RENDER_CHARS = 4_000;

/**
 * Renders arbitrary already-fetched JSON blobs (`outputJson`/
 * `finalPayloadJson`), which the wire types genuinely carry as `unknown`.
 */
// eslint-disable-next-line local/no-unknown-parameter-type
function renderJson(value: unknown, cap = MAX_JSON_RENDER_CHARS): string {
  if (value === null || value === undefined) return "null";
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    return "<unserializable>";
  }
  if (text.length <= cap) return text;
  const omitted = text.length - cap;
  return `${text.slice(0, cap)}\n… [truncated, ${String(omitted)} more characters]`;
}

export type FormatStepDetailInput = {
  stepItem: ExecutionStepItem;
  /** The step's `StepExecution` row (has real `startedAt`/`completedAt` and,
   * once terminal, `result.signals`) — `null` when the step run has no
   * `stepExecutionId` yet (not yet claimed by a worker). */
  stepExecution: StepExecution | null;
};

/**
 * Decision 9's `--step <key>` output: status, satisfaction, timestamps, work
 * branch, signals, truncated output JSON, evaluation. Everything except logs
 * and artifacts, which stay opt-in (`--log`/`--artifacts`, formatted
 * separately by `format-logs.ts` and {@link formatStepArtifacts}).
 */
export function formatStepDetail(input: FormatStepDetailInput): string {
  const { stepItem, stepExecution } = input;
  const lines: string[] = [];
  const name = stepItem.definition?.name ?? stepItem.stepKey;

  lines.push(`Step: ${stepItem.stepKey} (${name})`);

  if (stepItem.stepRun === null) {
    lines.push("Status: not reached yet in this attempt");
    return lines.join("\n");
  }

  const run = stepItem.stepRun;
  lines.push(
    `Status: ${statusGlyph(run.status)} ${run.status}   Satisfaction: ${run.satisfactionStatus}`,
  );
  lines.push(`Node kind: ${run.nodeKind}`);
  lines.push(`Work branch: ${run.workBranch ?? "—"}`);
  lines.push(
    `Started:   ${stepExecution?.startedAt ?? "—"}`,
  );
  lines.push(
    `Completed: ${stepExecution?.completedAt ?? "—"}`,
  );

  if (run.acceptedByUserId !== null) {
    lines.push(
      `Accepted by ${run.acceptedByUserId} at ${run.acceptedAt ?? "—"}${
        run.acceptanceReason ? `: ${run.acceptanceReason}` : ""
      }`,
    );
  }

  lines.push("");
  lines.push("Signals:");
  const signals = stepExecution?.result?.signals ?? [];
  if (signals.length === 0) {
    lines.push(
      stepExecution === null
        ? "  (no step execution yet)"
        : "  (none)",
    );
  } else {
    for (const signal of signals) {
      lines.push(`  ${signal.key} (${signal.type}, ${signal.source}):`);
      lines.push(`    ${renderJson(signal.valueJson, 500)}`);
    }
  }

  lines.push("");
  lines.push("Output JSON:");
  lines.push(indent(renderJson(run.outputJson)));

  lines.push("");
  lines.push("Evaluation:");
  if (run.evaluation === null) {
    lines.push("  (not evaluated yet)");
  } else {
    lines.push(
      `  Decision: ${run.evaluation.decisionKind}   Final status: ${run.evaluation.finalStatus}   Final action: ${run.evaluation.finalAction}`,
    );
    lines.push("  Payload:");
    lines.push(indent(renderJson(run.evaluation.finalPayloadJson), "    "));
  }

  return lines.join("\n");
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export type StepArtifactEntry = {
  artifact: Artifact;
  /** Resolved presigned download URL, or `null` when unavailable (see
   * `note`). */
  downloadUrl: string | null;
  /** Set when the download URL couldn't be resolved — e.g. "expired" for a
   * 410 `getArtifactDownloadUrl` response (Risks table) — or when the store
   * can't presign at all (`url: null` with no error). */
  note: string | null;
};

/**
 * Decision 11's `--artifacts` output: artifact list with presigned download
 * URLs, no auto-download. Kept separate from {@link formatStepDetail} (own
 * function, not folded into it) since it is fetched and rendered only when
 * `--artifacts` is passed.
 */
export function formatStepArtifacts(
  stepKey: string,
  entries: readonly StepArtifactEntry[],
): string {
  const lines: string[] = [`Artifacts for step ${stepKey}:`];
  if (entries.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const entry of entries) {
    const sizeLabel =
      entry.artifact.sizeBytes === null
        ? "unknown size"
        : `${String(entry.artifact.sizeBytes)} bytes`;
    lines.push(`  ${entry.artifact.relativeStorePath} (${sizeLabel})`);
    if (entry.downloadUrl !== null) {
      lines.push(`    ${entry.downloadUrl}`);
    } else {
      lines.push(`    (unavailable: ${entry.note ?? "unknown reason"})`);
    }
  }
  return lines.join("\n");
}
