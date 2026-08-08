/**
 * Presentation-layer contract for user-facing CLI output.
 *
 * This is intentionally distinct from {@link ProjectWorkLogger}, which is a
 * structured *logging* sink (pino) for diagnostics. A `WorkReporter` describes
 * human-meaningful *milestones* in the work lifecycle: things a developer
 * watching the terminal should see as friendly status, spinners, and
 * summaries — not raw NDJSON.
 *
 * The worker emits {@link WorkEvent}s; the CLI provides a concrete reporter
 * (e.g. a `@clack/prompts` implementation). Tests can pass `noopReporter`.
 */

/**
 * A discriminated union of the lifecycle milestones the worker surfaces to
 * the user. Each event is a *human* moment, not a log line. Keep the payloads
 * small and presentation-oriented (no internal IDs unless useful to a human).
 */
export type WorkEvent =
  | { type: "worker:starting"; projectId: string; concurrency: number }
  | { type: "worker:ready"; workerId: string }
  | { type: "worker:polling" }
  | { type: "worker:idle"; pollIntervalMs: number }
  | { type: "worker:claimed"; count: number }
  | { type: "worker:complete"; processed: number; skipped: number }
  | { type: "step:starting"; stepExecutionId: string }
  | { type: "step:runtime-launching"; stepExecutionId: string }
  | { type: "step:runtime-cloning"; stepExecutionId: string }
  | { type: "step:runtime-container-starting"; stepExecutionId: string }
  | {
      /**
       * Fine-grained progress while the devcontainer is being built/started
       * (notably the long `postCreateCommand` phase), parsed from the
       * devcontainer CLI output. Surfaced so the user sees real activity
       * instead of a frozen spinner.
       *
       * `kind: "milestone"` updates the primary status line (e.g. "Running the
       * postCreateCommand…"); `kind: "detail"` is a lower-level log line shown
       * in a rolling window beneath the milestone.
       *
       * `level` is the CLI's own severity for the line; the reporter uses it to
       * emphasize warnings/errors in the rolling window.
       */
      type: "step:runtime-container-progress";
      stepExecutionId: string;
      kind: "milestone" | "detail";
      phase: string;
      level?: "info" | "warn" | "error" | undefined;
    }
  | { type: "step:runtime-ai-starting"; stepExecutionId: string }
  | { type: "step:runtime-ready"; stepExecutionId: string }
  /**
   * The step declared health checks and they are now running against the
   * launched environment, before the agent is prompted (#120). Only emitted
   * for steps with a non-empty `healthChecks`; a step declaring none jumps
   * straight from `runtime-ready` to `agent-running` as before.
   */
  | { type: "step:health-checks-running"; stepExecutionId: string }
  | { type: "step:agent-running"; stepExecutionId: string }
  | { type: "step:succeeded"; stepExecutionId: string }
  | {
      type: "step:failed";
      stepExecutionId: string;
      reason: string;
    };

/**
 * Stable handle returned by {@link WorkReporter.startTask}. Lets the caller
 * update the live label and resolve the task as success/failure. In a TTY this
 * typically drives a spinner; off-TTY it degrades to plain lines.
 */
export type WorkTask = {
  /** Replace the in-progress label (e.g. update a spinner's text). */
  update(message: string): void;
  /** Resolve the task as succeeded, optionally with a final message. */
  succeed(message?: string): void;
  /** Resolve the task as failed, optionally with a final message. */
  fail(message?: string): void;
};

/**
 * User-facing output surface. Implementations decide how to render (spinners,
 * symbols, color) and how to behave off-TTY. This contract carries no
 * structured detail on purpose — diagnostics belong on the logger.
 */
export type WorkReporter = {
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
  /** Translate a structured {@link WorkEvent} into the appropriate output. */
  event(event: WorkEvent): void;
};

/** A reporter that renders nothing. Use in tests and non-interactive paths. */
export const noopReporter: WorkReporter = {
  startTask: () => ({
    update: () => {},
    succeed: () => {},
    fail: () => {},
  }),
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
  event: () => {},
};
