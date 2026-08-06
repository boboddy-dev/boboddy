import { test } from "bun:test";
import type { BaseReporter } from "../src/lib/reporter-types";

export const concurrentTest =
  ("concurrent" in test &&
  typeof (test as typeof test & { concurrent?: typeof test }).concurrent ===
    "function"
    ? (test as typeof test & { concurrent: typeof test }).concurrent
    : test);

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/**
 * Strip ANSI escape (color) codes from a string. The `PlainReporter` shouldn't
 * emit color, but be defensive so assertions match the raw text either way.
 */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

/**
 * Split a reporter's stderr output into trimmed, non-empty, ANSI-stripped lines.
 */
export function reporterLines(stderr: string): string[] {
  return stripAnsi(stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * True if any reporter line on stderr contains the given substring
 * (ANSI-stripped). This is the primary assertion helper for human output.
 */
export function hasReporterLine(stderr: string, substring: string): boolean {
  return reporterLines(stderr).some((line) => line.includes(substring));
}

/** One reporter call: which method, and what it was passed. */
export type RecordedReport = { method: string; message: string };

/**
 * A {@link BaseReporter} that records instead of rendering, for the command tails
 * and preflights whose behaviour is a sequence of reporter calls rather than
 * anything on a terminal.
 *
 * `calls` and `tasks` are separate because the assertions are: `calls` is the
 * message stream (did the user get told?), `tasks` is the spinner lifecycle (did
 * the step resolve, and did it succeed or fail?). Both preserve order, which is
 * usually the point — a block has to be closed before a child takes the tty.
 */
export function createReporterRecorder(): {
  reporter: BaseReporter;
  calls: RecordedReport[];
  tasks: RecordedReport[];
} {
  const calls: RecordedReport[] = [];
  const tasks: RecordedReport[] = [];
  const push = (method: string) => (message: string) => {
    calls.push({ method, message });
  };
  const pushTask = (method: string) => (message?: string) => {
    tasks.push({ method, message: message ?? "" });
  };
  return {
    calls,
    tasks,
    reporter: {
      start: push("start"),
      finish: push("finish"),
      startTask: (message: string) => {
        tasks.push({ method: "startTask", message });
        return {
          update: pushTask("update"),
          succeed: pushTask("succeed"),
          fail: pushTask("fail"),
        };
      },
      info: push("info"),
      success: push("success"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

/** The `message` of each recorded call, in order. */
export const reportedMessages = (calls: readonly RecordedReport[]): string[] =>
  calls.map((call) => call.message);

/** The `method` of each recorded call, in order. */
export const reportedMethods = (calls: readonly RecordedReport[]): string[] =>
  calls.map((call) => call.method);
