import type { LogLine, Task } from "./lib/api-types";
import { describeApiError } from "./lib/api-errors";
import { fetchArchiveLogLines } from "./lib/investigate-execution-fetchers";
import type {
  AuthHeaders,
  InvestigateExecutionClient,
} from "./lib/investigate-execution-client";

/** The two log reads {@link loadTaskLogLines} needs, so callers without a
 * full {@link InvestigateExecutionClient} (e.g. the worker) can pass one. */
export type TaskLogsClient = {
  tasks: Pick<
    InvestigateExecutionClient["tasks"],
    "getTaskLogArchive" | "readTaskLogs"
  >;
};

export type TaskLogLinesResult =
  { lines: LogLine[]; source: "archive" | "live" } | { unavailable: string };

/**
 * Loads every stream's log lines for a Task: the durable archive once the
 * Task has completed, the live feed while it is still running. API failures
 * come back as `{ unavailable }` with a one-line reason; a failed archive
 * download throws.
 */
export async function loadTaskLogLines(
  client: TaskLogsClient,
  headers: AuthHeaders,
  task: Pick<Task, "id" | "completedAt">,
): Promise<TaskLogLinesResult> {
  if (task.completedAt !== null) {
    const { data, error } = await client.tasks.getTaskLogArchive({
      path: { taskId: task.id },
      headers,
    });
    if (error !== undefined) {
      if (error.status === 402) {
        return {
          unavailable:
            "log archive read quota exceeded for this org this month (402 USAGE_LIMIT_EXCEEDED_READ). Logs are unavailable until the quota resets.",
        };
      }
      return {
        unavailable: `could not load log archive: ${describeApiError(error)}`,
      };
    }
    if (data.url === null) {
      return {
        unavailable:
          "no log archive is available (not archived yet, or the object store cannot presign a URL).",
      };
    }
    return { lines: await fetchArchiveLogLines(data.url), source: "archive" };
  }

  const { data, error } = await client.tasks.readTaskLogs({
    path: { taskId: task.id },
    query: { from: 0, limit: 2_000 },
    headers,
  });
  if (error !== undefined) {
    return {
      unavailable: `could not load live logs: ${describeApiError(error)}`,
    };
  }
  return { lines: data.lines, source: "live" };
}
