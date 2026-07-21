import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { CliReporter, WorkEvent, WorkTask } from "./reporter-types";

/**
 * One recorded reporter call. `t` is absolute epoch milliseconds so replays
 * can reconstruct both relative pacing and original wall-clock durations.
 * `startTask` calls are assigned a monotonically increasing `taskId`; the
 * returned task handle's calls are recorded as `task:update`/`task:succeed`/
 * `task:fail` referencing that id.
 */
export type RecordedReporterCall = {
  t: number;
  method:
    | "start"
    | "finish"
    | "info"
    | "success"
    | "warn"
    | "error"
    | "event"
    | "startTask"
    | "task:update"
    | "task:succeed"
    | "task:fail";
  args: unknown[];
  taskId?: number;
};

/**
 * Wrap a reporter so every call is appended (as JSONL) to `filePath` before
 * being forwarded. This is a *recording tee* for demo/replay tooling — the
 * wrapped reporter's rendering is unchanged. Writes are synchronous so lines
 * land in order even if the process exits abruptly.
 */
export function createRecordingReporter(
  inner: CliReporter,
  filePath: string,
): CliReporter {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let nextTaskId = 0;

  const record = (call: RecordedReporterCall): void => {
    appendFileSync(filePath, `${JSON.stringify(call)}\n`, "utf8");
  };

  const recordSimple = (
    method: RecordedReporterCall["method"],
    args: unknown[],
    taskId?: number,
  ): void => {
    record(
      taskId === undefined
        ? { t: Date.now(), method, args }
        : { t: Date.now(), method, args, taskId },
    );
  };

  return {
    start(title: string): void {
      recordSimple("start", [title]);
      inner.start(title);
    },
    finish(message: string): void {
      recordSimple("finish", [message]);
      inner.finish(message);
    },
    info(message: string): void {
      recordSimple("info", [message]);
      inner.info(message);
    },
    success(message: string): void {
      recordSimple("success", [message]);
      inner.success(message);
    },
    warn(message: string): void {
      recordSimple("warn", [message]);
      inner.warn(message);
    },
    error(message: string): void {
      recordSimple("error", [message]);
      inner.error(message);
    },
    event(event: WorkEvent): void {
      recordSimple("event", [event]);
      inner.event(event);
    },
    startTask(message: string): WorkTask {
      const taskId = nextTaskId++;
      recordSimple("startTask", [message], taskId);
      const task = inner.startTask(message);
      return {
        update(next: string): void {
          recordSimple("task:update", [next], taskId);
          task.update(next);
        },
        succeed(next?: string): void {
          recordSimple("task:succeed", next === undefined ? [] : [next], taskId);
          task.succeed(next);
        },
        fail(next?: string): void {
          recordSimple("task:fail", next === undefined ? [] : [next], taskId);
          task.fail(next);
        },
      };
    },
  };
}
