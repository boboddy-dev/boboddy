import type {
  LogLine,
  PipelineDefinition,
  PipelineExecution,
  StepExecution,
  StepExecutionLogStream,
  WorkItem,
} from "./api-types";
import { describeApiError } from "./api-errors";
import type {
  AuthHeaders,
  InvestigateExecutionClient,
} from "./investigate-execution-client";

/** Thin, throwing wrappers around each read call `investigateExecution`
 * needs. Split out from `investigate-execution.ts` to keep that file's
 * orchestration logic readable and under the repo's 400-line file cap. */

export async function fetchExecution(
  client: InvestigateExecutionClient,
  headers: AuthHeaders,
  executionId: string,
): Promise<PipelineExecution> {
  const { data, error } = await client.pipelineExecutions.getPipelineExecution(
    { path: { pipelineExecutionId: executionId }, headers },
  );
  if (error !== undefined) {
    if (error.status === 404) {
      throw new Error(`Pipeline execution ${executionId} not found.`);
    }
    throw new Error(
      `Could not load pipeline execution ${executionId}: ${describeApiError(error)}`,
    );
  }
  return data;
}

export async function fetchPipelineDefinition(
  client: InvestigateExecutionClient,
  headers: AuthHeaders,
  pipelineDefinitionId: string,
): Promise<PipelineDefinition> {
  const { data, error } =
    await client.pipelineDefinitions.getPipelineDefinition({
      path: { pipelineDefinitionId },
      headers,
    });
  if (error !== undefined) {
    throw new Error(
      `Could not load pipeline definition ${pipelineDefinitionId}: ${describeApiError(error)}`,
    );
  }
  return data;
}

export async function fetchWorkItem(
  client: InvestigateExecutionClient,
  headers: AuthHeaders,
  workItemId: string,
): Promise<WorkItem> {
  const { data, error } = await client.workItems.getWorkItem({
    path: { workItemId },
    headers,
  });
  if (error !== undefined) {
    throw new Error(
      `Could not load work item ${workItemId}: ${describeApiError(error)}`,
    );
  }
  return data;
}

export async function fetchStepExecution(
  client: InvestigateExecutionClient,
  headers: AuthHeaders,
  stepExecutionId: string,
): Promise<StepExecution> {
  const { data, error } = await client.stepExecutions.getStepExecution({
    path: { stepExecutionId },
    headers,
  });
  if (error !== undefined) {
    throw new Error(
      `Could not load step execution ${stepExecutionId}: ${describeApiError(error)}`,
    );
  }
  return data;
}

export function filterByStream(
  lines: readonly LogLine[],
  requestedStream: StepExecutionLogStream | "all",
): LogLine[] {
  if (requestedStream === "all") return [...lines];
  return lines.filter((line) => line.stream === requestedStream);
}

/**
 * Downloads and parses the NDJSON log archive at a presigned URL.
 * `finalize-step-execution-log.ts` stores the archive gzip-compressed with
 * `Content-Encoding: gzip` (see `object-store.ts`'s `PutObjectInput.compress`
 * doc comment: "HTTP clients fetching via a presigned URL decompress
 * transparently"), so a plain `fetch` already receives decompressed bytes —
 * no manual gunzip needed here. Malformed lines are skipped rather than
 * failing the whole fetch.
 */
export async function fetchArchiveLogLines(url: string): Promise<LogLine[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download log archive (HTTP ${String(response.status)}).`,
    );
  }
  const text = await response.text();
  const lines: LogLine[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim().length === 0) continue;
    try {
      lines.push(JSON.parse(rawLine) as LogLine);
    } catch {
      // Skip malformed lines rather than failing the whole archive read.
    }
  }
  return lines;
}
