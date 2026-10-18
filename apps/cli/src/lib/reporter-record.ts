import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { CliReporter, WorkEvent, WorkActivity } from "./reporter-types";

/**
 * One recorded reporter call. `t` is absolute epoch milliseconds so replays
 * can reconstruct both relative pacing and original wall-clock durations.
 * `startActivity` calls are assigned a monotonically increasing `activityId`; the
 * returned activity handle's calls are recorded as `activity:update`/`activity:succeed`/
 * `activity:fail` referencing that id.
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
    | "startActivity"
    | "activity:update"
    | "activity:succeed"
    | "activity:fail";
  args: unknown[];
  activityId?: number;
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
  let nextActivityId = 0;

  const record = (call: RecordedReporterCall): void => {
    appendFileSync(filePath, `${JSON.stringify(call)}\n`, "utf8");
  };

  const recordSimple = (
    method: RecordedReporterCall["method"],
    args: unknown[],
    activityId?: number,
  ): void => {
    record(
      activityId === undefined
        ? { t: Date.now(), method, args }
        : { t: Date.now(), method, args, activityId },
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
    startActivity(message: string): WorkActivity {
      const activityId = nextActivityId++;
      recordSimple("startActivity", [message], activityId);
      const activity = inner.startActivity(message);
      return {
        update(next: string): void {
          recordSimple("activity:update", [next], activityId);
          activity.update(next);
        },
        succeed(next?: string): void {
          recordSimple("activity:succeed", next === undefined ? [] : [next], activityId);
          activity.succeed(next);
        },
        fail(next?: string): void {
          recordSimple("activity:fail", next === undefined ? [] : [next], activityId);
          activity.fail(next);
        },
      };
    },
  };
}
