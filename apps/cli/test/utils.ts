import { test } from "bun:test";

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
