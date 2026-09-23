import type { PipelineStepDefinition, PipelineStepRun } from "./api-types";

/**
 * One row in the resolved attempt's step rail: a step key paired with its
 * definition (when known) and representative run (when reached).
 *
 * Deliberately re-implemented here rather than imported from
 * `apps/next/components/executions/execution-step-items.ts`: that module is
 * part of the Next.js app and typed against `@boboddy/api/frontend-contracts`,
 * which `platform-client` does not depend on. The grouping/representative-run
 * logic (decision 7 — fan-out/parallel/loop branch selection is out of scope
 * for v1, so the "representative" run with `branchIndex == null`, falling
 * back to the first run, is what gets shown) is copied verbatim from that
 * module's `representativeStepRun`.
 */
export type ExecutionStepItem = {
  stepKey: string;
  position: number;
  definition: PipelineStepDefinition | null;
  /** The representative run for this key, or `null` if the step has not
   * been reached by this attempt yet. */
  stepRun: PipelineStepRun | null;
  runs: readonly PipelineStepRun[];
};

function representativeStepRun(
  runs: readonly PipelineStepRun[],
): PipelineStepRun | null {
  if (runs.length === 0) return null;
  return runs.find((run) => run.branchIndex == null) ?? runs[0] ?? null;
}

function groupStepRunsByKey(
  stepRuns: readonly PipelineStepRun[],
): Map<string, PipelineStepRun[]> {
  const grouped = new Map<string, PipelineStepRun[]>();
  for (const stepRun of stepRuns) {
    const existing = grouped.get(stepRun.stepKey);
    if (existing) {
      existing.push(stepRun);
    } else {
      grouped.set(stepRun.stepKey, [stepRun]);
    }
  }
  return grouped;
}

/**
 * Builds one {@link ExecutionStepItem} per step key known either from the
 * pipeline definition's step list (not-yet-reached steps included, `stepRun:
 * null`) or from an orphaned run (a key with runs but no matching
 * definition — kept rather than dropped, since a stale/removed step
 * definition shouldn't hide historical run data).
 */
export function buildExecutionStepItems(
  stepDefinitions: readonly PipelineStepDefinition[],
  stepRuns: readonly PipelineStepRun[],
): ExecutionStepItem[] {
  const runsByKey = groupStepRunsByKey(stepRuns);

  const items: ExecutionStepItem[] = stepDefinitions.map((definition) => {
    const runs = runsByKey.get(definition.key) ?? [];
    return {
      stepKey: definition.key,
      position: definition.position,
      definition,
      stepRun: representativeStepRun(runs),
      runs,
    };
  });

  for (const [stepKey, runs] of runsByKey) {
    if (items.some((item) => item.stepKey === stepKey)) continue;
    const [firstRun] = runs;
    items.push({
      stepKey,
      position: firstRun?.position ?? 0,
      definition: null,
      stepRun: representativeStepRun(runs),
      runs,
    });
  }

  return items.sort((left, right) => {
    if (left.position !== right.position) return left.position - right.position;
    return left.stepKey.localeCompare(right.stepKey);
  });
}
