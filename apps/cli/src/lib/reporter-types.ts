import {
  type WorkEvent,
  type WorkReporter,
  type WorkTask,
  noopReporter,
} from "@boboddy/worker";

export { noopReporter };
export type { WorkReporter, WorkTask, WorkEvent };

/**
 * CLI-owned, general-purpose output surface for *all* commands. It is the
 * subset of behavior every command needs: an intro/outro pair plus the
 * milestone/task primitives.
 *
 * This deliberately does NOT include the worker-specific `event(WorkEvent)`
 * method, so `BaseReporter` is neither a subtype nor a supertype of the
 * worker's {@link WorkReporter} (the worker lacks `start`/`finish`; the base
 * lacks `event`). Commands that don't drive the worker should depend on this
 * narrow surface so they can't accidentally call `event`.
 */
export type BaseReporter = {
  /** Render the intro banner. */
  start(title: string): void;
  /** Render the closing summary and tear down any live spinner. */
  finish(message: string): void;
  /** Begin a long-running, cancelable task; returns a handle to resolve it. */
  startTask(message: string): WorkTask;
  /** A neutral, transient status line. */
  info(message: string): void;
  /** A positive, completed milestone. */
  success(message: string): void;
  /** A non-fatal caution. */
  warn(message: string): void;
  /** A failure the user should notice. */
  error(message: string): void;
};

/**
 * The full reporter surface used by the `work` command: everything in
 * {@link BaseReporter} plus the worker's `event(WorkEvent)` method. Concrete
 * reporters (`ClackReporter`, `PlainReporter`) implement this whole surface,
 * so they satisfy both `BaseReporter` and {@link WorkReporter}.
 */
export type CliReporter = WorkReporter & {
  /** Render the intro banner. */
  start(title: string): void;
  /** Render the closing summary and tear down any live spinner. */
  finish(message: string): void;
};

/** A base reporter that renders nothing. Use in tests and non-interactive paths. */
export const noopBaseReporter: BaseReporter = {
  start: () => {},
  finish: () => {},
  startTask: () => ({
    update: () => {},
    succeed: () => {},
    fail: () => {},
  }),
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Shorten a long opaque id (e.g. `019ed1b9-c02d-7170-a08a-1ff912085f7b`) to
 * something a human can eyeball without it dominating the line.
 */
export function shortId(id: string): string {
  if (id.length <= 12) {
    return id;
  }
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * Format elapsed milliseconds as a human-readable duration.
 * Under 60 s → "12s"; 60 s and above → "1m 04s".
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
}
