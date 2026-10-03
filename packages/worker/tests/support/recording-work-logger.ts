/**
 * A {@link ProjectWorkLogger} fake that records every call with its level, so
 * tests can assert which channel (`log` ships at the default ship level,
 * `debug` does not) a line was emitted on.
 */
import type { ProjectWorkLogger } from "../../src/work/step-execution/contracts/process-project-work-types";

export type RecordedLogEntry = {
  level: "debug" | "log" | "error";
  scope: string;
  message: string;
  details?: Record<string, unknown> | undefined;
};

export function createRecordingWorkLogger() {
  const entries: RecordedLogEntry[] = [];
  const record =
    (level: RecordedLogEntry["level"]) =>
    (scope: string, message: string, details?: Record<string, unknown>) => {
      entries.push({ level, scope, message, details });
    };
  const logger: ProjectWorkLogger = {
    debug: record("debug"),
    log: record("log"),
    error: record("error"),
  };
  return { entries, logger };
}
