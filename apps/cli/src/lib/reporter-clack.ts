import * as clack from "@clack/prompts";
import pc from "picocolors";
import type { WorkEvent, WorkReporter, WorkTask } from "./reporter-types";
import { formatElapsed, shortId } from "./reporter-types";

/** State tracked for an in-flight step. */
type ActiveStep = {
  spinner: ReturnType<typeof clack.spinner>;
  startedAt: number;
  /** Last phase label shown (without the step-id prefix). */
  phase: string;
  /**
   * When the step enters the devcontainer-launch phase we swap the spinner for
   * a `taskLog`: a fixed title line plus a rolling window of streamed sub-log
   * lines. While present, the spinner is stopped and `taskLog` owns the live
   * region. Resolved (success/error) when the launch phase ends or the step
   * finishes.
   */
  taskLog?: ReturnType<typeof clack.taskLog>;
};

/**
 * How many recent devcontainer log lines to keep visible under the title.
 * Enough to show a meaningful tail of the lifecycle without flooding the
 * terminal. On failure, these retained lines are the primary diagnostic hint
 * shown to the user (the raw output is in the pino log file).
 */
const DEVCONTAINER_LOG_WINDOW = 12;

/**
 * Max width (chars) for a single devcontainer log line in the rolling window.
 * Lines longer than this are truncated with an ellipsis so the window doesn't
 * wrap and blow up the height of the live region.
 */
const DEVCONTAINER_LINE_MAX_WIDTH = 100;

/**
 * Max length for the step failure reason shown inline beneath the spinner.
 * With the raw devcontainer CLI output stripped upstream this is now a clean
 * single-sentence message, so 500 chars is a generous safety net.
 */
const STEP_REASON_MAX_LENGTH = 500;

/**
 * A `WorkReporter` backed by `@clack/prompts`. Renders friendly, hierarchical
 * status to a TTY: an intro banner, a live timer-spinner for the current step,
 * and static log lines for completed steps.
 *
 * Only one spinner is active at a time — clack's cursor-manipulation renders
 * incorrectly with multiple concurrent spinners. When a second step starts
 * while one is already spinning (concurrency > 1) the existing spinner is
 * parked as a static log line and the new step takes over the live spinner.
 *
 * This is a *presentation* surface only — all diagnostic detail still flows
 * through pino. The two are deliberately separate sinks.
 */
export class ClackReporter implements WorkReporter {
  /** Live spinner state, keyed by stepExecutionId. At most one is active. */
  private readonly activeSteps = new Map<string, ActiveStep>();

  /**
   * Clock used for step `startedAt` capture and elapsed-duration labels.
   * Injectable so replay tooling can render original wall-clock durations
   * while dispatching on a compressed schedule.
   */
  private readonly now: () => number;

  constructor(
    private readonly logFilePath?: string,
    options?: { now?: () => number },
  ) {
    this.now = options?.now ?? Date.now;
  }

  start(title: string): void {
    clack.intro(pc.bgCyan(pc.black(` ${title} `)));
    if (this.logFilePath) {
      clack.log.info(`Logs → ${pc.dim(this.logFilePath)}`);
    }
  }

  finish(message: string): void {
    // Park any dangling spinners / close any open taskLogs before closing.
    for (const [id, step] of this.activeSteps) {
      if (step.taskLog) {
        step.taskLog.success(this.stepLabel(id, step.phase, step.startedAt), {
          showLog: false,
        });
      } else {
        step.spinner.stop(this.stepLabel(id, step.phase, step.startedAt));
      }
    }
    this.activeSteps.clear();
    clack.outro(message);
  }

  startTask(message: string): WorkTask {
    const task = clack.spinner({ indicator: "timer" });
    task.start(message);
    return {
      update: (next) => { task.message(next); },
      succeed: (next) => { task.stop(next ? pc.green(next) : undefined); },
      fail: (next) => { task.error(next ? pc.red(next) : undefined); },
    };
  }

  info(message: string): void {
    clack.log.info(message);
  }

  success(message: string): void {
    clack.log.success(pc.green(message));
  }

  warn(message: string): void {
    clack.log.warn(pc.yellow(message));
  }

  error(message: string): void {
    clack.log.error(pc.red(message));
  }

  event(event: WorkEvent): void {
    switch (event.type) {
      case "worker:starting":
        this.info(
          `Project ${pc.dim(shortId(event.projectId))} · concurrency ${pc.bold(
            String(event.concurrency),
          )}`,
        );
        return;
      case "worker:ready":
        this.success(`Worker ready ${pc.dim(`(${shortId(event.workerId)})`)}`);
        return;
      case "worker:claimed":
        this.info(
          `Claimed ${pc.bold(String(event.count))} step${
            event.count === 1 ? "" : "s"
          }`,
        );
        return;
      case "worker:complete":
        this.success(
          `Run complete · ${pc.bold(String(event.processed))} processed` +
            (event.skipped > 0
              ? `, ${pc.yellow(`${String(event.skipped)} skipped`)}`
              : ""),
        );
        return;

      case "step:starting": {
        // If another step is already spinning, park it as a static line so
        // the new step can take over the live spinner slot.
        this.parkAllSpinners();
        const spin = clack.spinner({ indicator: "timer" });
        spin.start(this.stepLabel(event.stepExecutionId, "starting"));
        this.activeSteps.set(event.stepExecutionId, {
          spinner: spin,
          startedAt: this.now(),
          phase: "starting",
        });
        return;
      }

      case "step:runtime-launching":
        this.updateSpinner(event.stepExecutionId, "launching runtime…");
        return;
      case "step:runtime-cloning":
        this.updateSpinner(event.stepExecutionId, "cloning repository…");
        return;
      case "step:runtime-container-starting":
        // Enter taskLog mode: a fixed title line with rolling sub-logs beneath.
        this.beginDevcontainerLog(event.stepExecutionId);
        return;
      case "step:runtime-container-progress":
        this.appendDevcontainerLog(
          event.stepExecutionId,
          event.kind,
          event.phase,
          event.level ?? "info",
        );
        return;
      case "step:runtime-ai-starting":
        // Devcontainer is up; close its log region and resume the spinner.
        this.endDevcontainerLog(event.stepExecutionId, true);
        this.updateSpinner(event.stepExecutionId, "starting AI container…");
        return;
      case "step:runtime-ready":
        this.endDevcontainerLog(event.stepExecutionId, true);
        this.updateSpinner(event.stepExecutionId, "runtime ready");
        return;
      case "step:health-checks-running":
        this.updateSpinner(event.stepExecutionId, "running health checks…");
        return;
      case "step:agent-running":
        this.updateSpinner(event.stepExecutionId, "agent running");
        return;

      case "step:succeeded": {
        // If the devcontainer log region is still open, close it cleanly first.
        this.endDevcontainerLog(event.stepExecutionId, true);
        const step = this.activeSteps.get(event.stepExecutionId);
        if (step) {
          const duration = formatElapsed(this.now() - step.startedAt);
          step.spinner.stop(
            pc.green(`Step ${pc.dim(shortId(event.stepExecutionId))} succeeded`) +
              pc.dim(` (${duration})`),
          );
          this.activeSteps.delete(event.stepExecutionId);
        } else {
          this.success(`Step ${pc.dim(shortId(event.stepExecutionId))} succeeded`);
        }
        return;
      }

      case "step:failed": {
        // With raw devcontainer output stripped upstream, the reason is now a
        // clean single-line message. Truncate only as a safety net.
        const reason =
          event.reason.length > STEP_REASON_MAX_LENGTH
            ? `${event.reason.slice(0, STEP_REASON_MAX_LENGTH)}…`
            : event.reason;
        const logHint = this.logFilePath
          ? `\n  ${pc.dim(`Full logs: ${this.logFilePath}`)}`
          : "";
        // Retain the devcontainer sub-logs on failure (showLog: true) so the
        // user can see the last lifecycle phase where it broke.
        this.endDevcontainerLog(event.stepExecutionId, false);
        const step = this.activeSteps.get(event.stepExecutionId);
        if (step) {
          const duration = formatElapsed(this.now() - step.startedAt);
          step.spinner.error(
            pc.red(`Step ${pc.dim(shortId(event.stepExecutionId))} failed`) +
              pc.dim(` (${duration})`) +
              `\n  ${pc.yellow(reason)}${logHint}`,
          );
          this.activeSteps.delete(event.stepExecutionId);
        } else {
          this.error(
            `Step ${pc.dim(shortId(event.stepExecutionId))} failed` +
              `\n  ${pc.yellow(reason)}${logHint}`,
          );
        }
        return;
      }

      // Idle/polling are high-frequency, low-signal heartbeats. Dropping them
      // keeps the log readable; `--verbose` pino logs still capture them.
      case "worker:polling":
      case "worker:idle":
        return;
    }
  }

  /**
   * Build the spinner message label for a step.
   * When `startedAt` is provided the elapsed is appended so the parked line
   * captures the final duration at park time.
   */
  private stepLabel(stepExecutionId: string, phase: string, startedAt?: number): string {
    const elapsed = startedAt !== undefined
      ? pc.dim(` · ${formatElapsed(this.now() - startedAt)}`)
      : "";
    return `step ${pc.cyan(shortId(stepExecutionId))} ${pc.dim(phase)}${elapsed}`;
  }

  /** Update the live spinner message for a step. No-op if the step has no spinner. */
  private updateSpinner(stepExecutionId: string, phase: string): void {
    const step = this.activeSteps.get(stepExecutionId);
    if (!step) return;
    step.phase = phase;
    step.spinner.message(this.stepLabel(stepExecutionId, phase));
  }

  /**
   * Enter "devcontainer log" mode for a step: stop the live spinner and start a
   * `taskLog` whose title is the step line and whose body is a rolling window
   * of streamed devcontainer log lines. No-op if the step is unknown or already
   * in this mode.
   */
  private beginDevcontainerLog(stepExecutionId: string): void {
    const step = this.activeSteps.get(stepExecutionId);
    if (!step || step.taskLog) return;
    step.phase = "starting devcontainer…";
    // Hand the live region from the spinner to the taskLog.
    step.spinner.stop(this.stepLabel(stepExecutionId, step.phase));
    step.taskLog = clack.taskLog({
      title: this.stepLabel(stepExecutionId, step.phase),
      limit: DEVCONTAINER_LOG_WINDOW,
      retainLog: false,
    });
  }

  /**
   * Feed a devcontainer progress line into the step's open taskLog. Milestones
   * also update the (sticky) title; details only scroll in the body window.
   * No-op if the step has no open taskLog.
   */
  private appendDevcontainerLog(
    stepExecutionId: string,
    kind: "milestone" | "detail",
    phase: string,
    level: "info" | "warn" | "error",
  ): void {
    const step = this.activeSteps.get(stepExecutionId);
    if (!step?.taskLog) return;
    if (kind === "milestone") {
      step.phase = phase;
    }
    // Truncate wide lines so they can't wrap and blow up the live region height.
    const displayPhase =
      phase.length > DEVCONTAINER_LINE_MAX_WIDTH
        ? `${phase.slice(0, DEVCONTAINER_LINE_MAX_WIDTH - 1)}…`
        : phase;
    // Colorize by severity first (errors/warnings stand out), then fall back to
    // milestone/detail emphasis. Let clack frame each line (no `raw`) so the
    // bar prefix is preserved and the window stays within its region.
    let line: string;
    if (level === "error") {
      line = pc.red(displayPhase);
    } else if (level === "warn") {
      line = pc.yellow(displayPhase);
    } else {
      line = kind === "milestone" ? pc.cyan(displayPhase) : pc.dim(displayPhase);
    }
    step.taskLog.message(line);
  }

  /**
   * Close a step's devcontainer taskLog if open, resuming a fresh spinner so
   * subsequent phases keep their live timer line. On success the streamed body
   * is cleared; on failure (`success=false`) it is retained for debugging.
   * No-op if the step has no open taskLog.
   */
  private endDevcontainerLog(stepExecutionId: string, success: boolean): void {
    const step = this.activeSteps.get(stepExecutionId);
    if (!step?.taskLog) return;
    const title = this.stepLabel(stepExecutionId, step.phase, step.startedAt);
    if (success) {
      step.taskLog.success(title, { showLog: false });
    } else {
      step.taskLog.error(title, { showLog: true });
    }
    step.taskLog = undefined;
    // Resume a live spinner for the post-devcontainer phases.
    const spin = clack.spinner({ indicator: "timer" });
    spin.start(this.stepLabel(stepExecutionId, step.phase));
    step.spinner = spin;
  }

  /**
   * Stop all active spinners as static log lines (preserving their elapsed),
   * clearing the map. Used when a new step needs the live-spinner slot.
   */
  private parkAllSpinners(): void {
    for (const [id, step] of this.activeSteps) {
      if (step.taskLog) {
        step.taskLog.success(this.stepLabel(id, step.phase, step.startedAt), {
          showLog: false,
        });
      } else {
        step.spinner.stop(this.stepLabel(id, step.phase, step.startedAt));
      }
    }
    this.activeSteps.clear();
  }
}
