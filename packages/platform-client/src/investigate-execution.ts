import type {
  PipelineExecution,
  PipelineExecutionAttempt,
  Task,
  TaskLogStream,
} from "./lib/api-types";
import { describeApiError } from "./lib/api-errors";
import {
  buildExecutionStepItems,
  type ExecutionStepItem,
} from "./lib/execution-step-items";
import {
  fetchExecution,
  fetchPipelineDefinition,
  fetchTask,
  fetchWorkItem,
  filterByStream,
} from "./lib/investigate-execution-fetchers";
import type {
  AuthHeaders,
  InvestigateExecutionClient,
  FullLogSaver,
} from "./lib/investigate-execution-client";
import { formatExecutionSummary } from "./format-execution-summary";
import {
  formatStepArtifacts,
  formatStepDetail,
  type StepArtifactEntry,
} from "./format-step-detail";
import {
  capLogBody,
  MAX_LOG_RENDER_CHARS,
  renderLogText,
  withFullLogLocation,
} from "./format-logs";
import { loadTaskLogLines } from "./load-task-log-lines";

export type InvestigateExecutionOptions = {
  client: InvestigateExecutionClient;
  headers: AuthHeaders;
  executionId: string;
  /** Defaults to the latest attempt (decision 5). */
  attempt?: number;
  /** A step key to drill into (decision 9). */
  step?: string;
  /** Fetch and render this step's logs (decision 10). Defaults `false`. */
  log?: boolean;
  /** Narrows `--log` to one stream; `"all"` (the default) fetches all
   * three. */
  logStream?: TaskLogStream | "all";
  /** List this step's artifacts with presigned download URLs (decision
   * 11). Defaults `false`. */
  artifacts?: boolean;
  /** Saves the full, uncapped log on every successful `--log` load; the
   * resolved path (or `not saved (<reason>)` on rejection) goes on the log
   * header line. Not called when logs are unavailable. */
  saveFullLog?: FullLogSaver;
};

function resolveAttempt(
  execution: PipelineExecution,
  attemptNumber: number | undefined,
): PipelineExecutionAttempt {
  if (execution.attempts.length === 0) {
    throw new Error(`Pipeline execution ${execution.id} has no attempts yet.`);
  }
  if (attemptNumber === undefined) {
    return execution.attempts.reduce((latest, candidate) =>
      candidate.attemptNumber > latest.attemptNumber ? candidate : latest,
    );
  }
  const found = execution.attempts.find(
    (candidate) => candidate.attemptNumber === attemptNumber,
  );
  if (found === undefined) {
    const available = execution.attempts
      .map((candidate) => candidate.attemptNumber)
      .sort((left, right) => left - right)
      .join(", ");
    throw new Error(
      `Attempt ${String(attemptNumber)} not found for pipeline execution ${execution.id}. Available attempts: ${available}.`,
    );
  }
  return found;
}

/** The step to target for `--log`/`--artifacts` when `--step` was not given
 * explicitly: the attempt's `currentStepKey`, or failing that (e.g. a
 * finished attempt with no "current" step) the last step position with any
 * run at all. `null` when the attempt has not started any step yet. */
function resolveDefaultStepKey(
  attempt: PipelineExecutionAttempt,
  stepItems: readonly ExecutionStepItem[],
): string | null {
  if (attempt.currentStepKey !== null) return attempt.currentStepKey;
  const touched = [...stepItems]
    .reverse()
    .find((item) => item.stepRun !== null);
  return touched?.stepKey ?? null;
}

/** Where the full log went, for the header line: the saved path, or why it
 * was not saved. A rejecting saver never fails the `execution view` call. */
async function saveFullLogText(
  saveFullLog: FullLogSaver,
  input: Parameters<FullLogSaver>[0],
): Promise<string> {
  try {
    return await saveFullLog(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `not saved (${reason})`;
  }
}

async function fetchAndFormatLogs(
  client: InvestigateExecutionClient,
  headers: AuthHeaders,
  stepKey: string,
  taskId: string,
  task: Task,
  requestedStream: TaskLogStream | "all",
  saveFullLog: FullLogSaver | undefined,
): Promise<string> {
  const loaded = await loadTaskLogLines(client, headers, {
    id: taskId,
    completedAt: task.completedAt,
  });
  if ("unavailable" in loaded) {
    return `Logs for step ${stepKey}: ${loaded.unavailable}`;
  }
  const fullText = renderLogText({
    stepKey,
    lines: filterByStream(loaded.lines, requestedStream),
    requestedStream,
    source: loaded.source,
  });
  const preview = capLogBody(fullText, MAX_LOG_RENDER_CHARS);
  if (saveFullLog === undefined) return preview;

  const location = await saveFullLogText(saveFullLog, {
    taskId,
    requestedStream,
    fullText,
  });
  return withFullLogLocation(preview, location);
}

async function fetchAndFormatArtifacts(
  client: InvestigateExecutionClient,
  headers: AuthHeaders,
  stepKey: string,
  taskId: string,
): Promise<string> {
  const { data, error } = await client.tasks.listTaskArtifacts({
    path: { taskId: taskId },
    headers,
  });
  if (error !== undefined) {
    return `Artifacts for step ${stepKey}: could not list artifacts: ${describeApiError(error)}`;
  }

  const entries: StepArtifactEntry[] = [];
  for (const artifact of data) {
    const result = await client.tasks.getArtifactDownloadUrl({
      path: { taskId: taskId, artifactId: artifact.id },
      headers,
    });
    if (result.error !== undefined) {
      entries.push({
        artifact,
        downloadUrl: null,
        note:
          result.error.status === 410
            ? "expired"
            : describeApiError(result.error),
      });
      continue;
    }
    entries.push({
      artifact,
      downloadUrl: result.data.url,
      note:
        result.data.url === null ? "object store cannot presign a URL" : null,
    });
  }

  return formatStepArtifacts(stepKey, entries);
}

/**
 * Fetches and formats everything needed to investigate one pipeline
 * execution: the execution + its pipeline definition + work item, the
 * resolved attempt (decision 5) and step (decision 7 — representative run
 * only), and `--log`/`--artifacts` data layered in only when requested
 * (decisions 10–11).
 *
 * Output shape by flags (see the plan's decision ledger, #8–11):
 *   - no `step`/`log`/`artifacts`: the execution summary (decision 8).
 *   - `step` given: that step's detail (decision 9), plus a `log`/`artifacts`
 *     section each, if those flags are also set.
 *   - `log`/`artifacts` given without `step`: targets the attempt's
 *     "current" step (or the last-touched one) — see
 *     {@link resolveDefaultStepKey} — with a one-line note instead of the
 *     full step detail (kept a deliberate simplification; not spelled out by
 *     the plan, which only describes `--step`'s own output shape).
 */
export async function investigateExecution(
  options: InvestigateExecutionOptions,
): Promise<string> {
  const {
    client,
    headers,
    executionId,
    attempt: attemptNumber,
    step: explicitStepKey,
    log = false,
    logStream = "all",
    artifacts = false,
    saveFullLog,
  } = options;

  const execution = await fetchExecution(client, headers, executionId);
  const [pipelineDefinition, workItem] = await Promise.all([
    fetchPipelineDefinition(client, headers, execution.pipelineDefinitionId),
    fetchWorkItem(client, headers, execution.workItemId),
  ]);

  const attempt = resolveAttempt(execution, attemptNumber);
  const stepItems = buildExecutionStepItems(
    pipelineDefinition.stepDefinitions,
    attempt.stepRuns,
  );

  const needsStepContext = explicitStepKey !== undefined || log || artifacts;
  if (!needsStepContext) {
    return formatExecutionSummary({
      execution,
      workItem,
      pipelineDefinition,
      attempt,
      stepItems,
    });
  }

  const resolvedStepKey =
    explicitStepKey ?? resolveDefaultStepKey(attempt, stepItems);
  if (resolvedStepKey === null) {
    throw new Error(
      `No step to show for pipeline execution ${execution.id}: attempt ${String(attempt.attemptNumber)} has not started any steps yet. Pass --step <key> explicitly, or omit --log/--artifacts to see the execution summary.`,
    );
  }

  const stepItem = stepItems.find((item) => item.stepKey === resolvedStepKey);
  if (stepItem === undefined) {
    const known = stepItems.map((item) => item.stepKey).join(", ") || "(none)";
    throw new Error(
      `Step "${resolvedStepKey}" not found in pipeline "${pipelineDefinition.key}". Known steps: ${known}.`,
    );
  }

  const taskId = stepItem.stepRun?.taskId ?? null;
  const task =
    taskId !== null ? await fetchTask(client, headers, taskId) : null;

  const sections: string[] = [];
  if (explicitStepKey !== undefined) {
    sections.push(formatStepDetail({ stepItem, task }));
  } else {
    sections.push(
      `Showing --log/--artifacts for step ${resolvedStepKey} (attempt ${String(attempt.attemptNumber)}'s current step; pass --step explicitly to target a different one).`,
    );
  }

  if (log) {
    sections.push(
      taskId === null || task === null
        ? `Logs for step ${resolvedStepKey}: no task yet.`
        : await fetchAndFormatLogs(
            client,
            headers,
            resolvedStepKey,
            taskId,
            task,
            logStream,
            saveFullLog,
          ),
    );
  }

  if (artifacts) {
    sections.push(
      taskId === null
        ? `Artifacts for step ${resolvedStepKey}: no task yet.`
        : await fetchAndFormatArtifacts(
            client,
            headers,
            resolvedStepKey,
            taskId,
          ),
    );
  }

  return sections.join("\n\n");
}
