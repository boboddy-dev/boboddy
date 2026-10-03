/**
 * Monotonic stopwatch for the human-readable timing lines in the step log.
 * `performance.now()` is unaffected by wall-clock adjustments.
 */
export function startStopwatch(): () => string {
  const startedAt = performance.now();
  return () => formatSeconds(performance.now() - startedAt);
}

export function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}
