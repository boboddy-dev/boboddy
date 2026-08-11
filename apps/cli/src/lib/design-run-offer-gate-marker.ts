import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persists the one fact phase-1 orientation needs on the NEXT
 * `pipelines design` invocation: did the previous session's post-push
 * run-offer gate (the first-step dry run, #146) fail?
 *
 * This has to be a file, not in-memory state: the run-offer runs in the host
 * CLI process, after the TUI — and the agent inside it — has already exited.
 * There is no live session left to self-heal, which is exactly why #146
 * requires the NEXT session's orientation to pick this up instead.
 *
 * The marker is consumed on read (deleted the moment the next session's seed
 * prompt is built from it) rather than tracked as open/closed state across
 * however many sessions it takes to fix: it exists to open one conversation
 * on re-entry, and that next session's own run-offer will write a fresh one
 * if the problem is still there.
 */

export const RUN_OFFER_GATE_FAILURE_FILENAME = ".run-offer-gate-failure.json";

export type RunOfferGateFailure = {
  pipelineDefinitionId: string;
  /** See `summarizeDryRunFailure` in `dry-run-report.ts`. */
  summary: string;
  failedAt: string;
};

function markerPath(builderDir: string): string {
  return join(builderDir, RUN_OFFER_GATE_FAILURE_FILENAME);
}

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function isRunOfferGateFailure(value: unknown): value is RunOfferGateFailure {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["pipelineDefinitionId"] === "string" &&
    typeof record["summary"] === "string" &&
    typeof record["failedAt"] === "string"
  );
}

/** Record the failure so the next session's orientation can surface it. */
export function writeRunOfferGateFailure(
  builderDir: string,
  failure: Omit<RunOfferGateFailure, "failedAt">,
): void {
  const record: RunOfferGateFailure = {
    ...failure,
    failedAt: new Date().toISOString(),
  };
  writeFileSync(
    markerPath(builderDir),
    JSON.stringify(record, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Best-effort cleanup after a dry run that succeeded — a marker from an
 * earlier, since-fixed failure no longer describes reality. Failure to remove
 * it is not worth failing the run offer over, so this never throws.
 */
export function clearRunOfferGateFailure(builderDir: string): void {
  try {
    rmSync(markerPath(builderDir), { force: true });
  } catch {
    // Best-effort — see the docblock above.
  }
}

/**
 * Read and consume the marker, if any. Consumed (deleted) immediately,
 * whether or not it parsed — a marker malformed enough not to parse is no
 * more useful the second time either.
 */
export function readAndConsumeRunOfferGateFailure(
  builderDir: string,
): RunOfferGateFailure | undefined {
  const path = markerPath(builderDir);
  if (!existsSync(path)) return undefined;

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isRunOfferGateFailure(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    clearRunOfferGateFailure(builderDir);
  }
}
