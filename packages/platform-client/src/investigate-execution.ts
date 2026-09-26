import type {
  PipelineExecution,
  PipelineExecutionAttempt,
  StepExecution,
  StepExecutionLogStream,
} from "./lib/api-types";
import { describeApiError } from "./lib/api-errors";
import {
  buildExecutionStepItems,
  type ExecutionStepItem,
} from "./lib/execution-step-items";
import {
  fetchArchiveLogLines,
  fetchExecution,
  fetchPipelineDefinition,
  fetchStepExecution,
  fetchWorkItem,
  filterByStream,
} from "./lib/investigate-execution-fetchers";
import type {
  AuthHeaders,
  InvestigateExecutionClient,
  LogArtifactWriter,
} from "./lib/investigate-execution-client";
import { formatExecutionSummary } from "./format-execution-summary";
import {
  formatStepArtifacts,
  formatStepDetail,
  type StepArtifactEntry,
} from "./format-step-detail";
import { capLogBody, MAX_LOG_RENDER_CHARS, renderLogText } from "./format-logs";

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
  logStream?: StepExecutionLogStream | "all";
  /** List this step's artifacts with presigned download URLs (decision
   * 11). Defaults `false`. */
  artifacts?: boolean;
  /** Writes the full log to a local artifact when the rendered output
   * would exceed {@link MAX_LOG_RENDER_CHARS}, so the truncation notice can
   * point to it. Only invoked when truncation actually happens (decision
   * 6 — lazy); a rejection is swallowed and the output falls back to the
   * path-less notice (decision 9). */
  writeLogArtifact?: LogArtifactWriter;
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

/**
 * Renders a {@link renderLogText} input to its final, capped string,
 * writing the full text to `writeLogArtifact` first when (and only when —
 * decision 6) it would otherwise be truncated. A rejecting writer is
 * swallowed (decision 9): the caller still gets the path-less notice rather
 * than a failed `execution view` call.
 */
async function renderAndCapLogs(
  input: Parameters<typeof renderLogText>[0],
  stepExecutionId: string,
  requestedStream: StepExecutionLogStream | "all",
  writeLogArtifact: LogArtifactWriter | undefined,
): Promise<string> {
  const fullText = renderLogText(input);

  let filePath: string | undefined;
  if (
    fullText.length > MAX_LOG_RENDER_CHARS &&
    writeLogArtifact !== undefined
  ) {
    try {
      filePath = await writeLogArtifact({
        stepExecutionId,
        requestedStream,
        fullText,
      });
    } catch {
      filePath = undefined;
    }
  }

  return capLogBody(fullText, MAX_LOG_RENDER_CHARS, { filePath });
}

async function fetchAndFormatLogs(
  client: InvestigateExecutionClient,
  headers: AuthHeaders,
  stepKey: string,
  stepExecutionId: string,
  stepExecution: StepExecution | null,
  requestedStream: StepExecutionLogStream | "all",
  writeLogArtifact: LogArtifactWriter | undefined,
): Promise<string> {
  const isTerminal =
    stepExecution !== null && stepExecution.completedAt !== null;

  if (isTerminal) {
    const { data, error } =
      await client.stepExecutions.getStepExecutionLogArchive({
        path: { stepExecutionId },
        headers,
      });
    if (error !== undefined) {
      if (error.status === 402) {
        return `Logs for step ${stepKey}: log archive read quota exceeded for this org this month (402 USAGE_LIMIT_EXCEEDED_READ). Logs are unavailable until the quota resets.`;
      }
      return `Logs for step ${stepKey}: could not load log archive: ${describeApiError(error)}`;
    }
    if (data.url === null) {
      return `Logs for step ${stepKey}: no log archive is available (not archived yet, or the object store cannot presign a URL).`;
    }
    const lines = await fetchArchiveLogLines(data.url);
    return renderAndCapLogs(
      {
        stepKey,
        lines: filterByStream(lines, requestedStream),
        requestedStream,
        source: "archive",
      },
      stepExecutionId,
      requestedStream,
      writeLogArtifact,
    );
  }

  const { data, error } = await client.stepExecutions.readStepExecutionLogs({
    path: { stepExecutionId },
    query: { from: 0, limit: 2_000 },
    headers,
  });
  if (error !== undefined) {
    return `Logs for step ${stepKey}: could not load live logs: ${describeApiError(error)}`;
  }
  return renderAndCapLogs(
    {
      stepKey,
      lines: filterByStream(data.lines, requestedStream),
      requestedStream,
      source: "live",
    },
    stepExecutionId,
    requestedStream,
    writeLogArtifact,
  );
}

async function fetchAndFormatArtifacts(
  client: InvestigateExecutionClient,
  headers: AuthHeaders,
  stepKey: string,
  stepExecutionId: string,
): Promise<string> {
  const { data, error } =
    await client.stepExecutions.listStepExecutionArtifacts({
      path: { stepExecutionId },
      headers,
    });
  if (error !== undefined) {
    return `Artifacts for step ${stepKey}: could not list artifacts: ${describeApiError(error)}`;
  }

  const entries: StepArtifactEntry[] = [];
  for (const artifact of data) {
    const result = await client.stepExecutions.getArtifactDownloadUrl({
      path: { stepExecutionId, artifactId: artifact.id },
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
    writeLogArtifact,
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

  const stepExecutionId = stepItem.stepRun?.stepExecutionId ?? null;
  const stepExecution =
    stepExecutionId !== null
      ? await fetchStepExecution(client, headers, stepExecutionId)
      : null;

  const sections: string[] = [];
  if (explicitStepKey !== undefined) {
    sections.push(formatStepDetail({ stepItem, stepExecution }));
  } else {
    sections.push(
      `Showing --log/--artifacts for step ${resolvedStepKey} (attempt ${String(attempt.attemptNumber)}'s current step; pass --step explicitly to target a different one).`,
    );
  }

  if (log) {
    sections.push(
      stepExecutionId === null
        ? `Logs for step ${resolvedStepKey}: no step execution yet.`
        : await fetchAndFormatLogs(
            client,
            headers,
            resolvedStepKey,
            stepExecutionId,
            stepExecution,
            logStream,
            writeLogArtifact,
          ),
    );
  }

  if (artifacts) {
    sections.push(
      stepExecutionId === null
        ? `Artifacts for step ${resolvedStepKey}: no step execution yet.`
        : await fetchAndFormatArtifacts(
            client,
            headers,
            resolvedStepKey,
            stepExecutionId,
          ),
    );
  }

  return sections.join("\n\n");
}
