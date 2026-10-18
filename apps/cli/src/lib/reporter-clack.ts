import * as clack from "@clack/prompts";
import pc from "picocolors";
import type { WorkEvent, WorkReporter, WorkActivity } from "./reporter-types";
import { formatElapsed, shortId } from "./reporter-types";

/** State tracked for an in-flight task. */
type ActiveTask = {
  spinner: ReturnType<typeof clack.spinner>;
  startedAt: number;
  /** Last phase label shown (without the task-id prefix). */
  phase: string;
  /**
   * When the task enters the devcontainer-launch phase we swap the spinner for
   * a `taskLog`: a fixed title line plus a rolling window of streamed sub-log
   * lines. While present, the spinner is stopped and `taskLog` owns the live
   * region. Resolved (success/error) when the launch phase ends or the task
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
 * Max length for the task failure reason shown inline beneath the spinner.
 * With the raw devcontainer CLI output stripped upstream this is now a clean
 * single-sentence message, so 500 chars is a generous safety net.
 */
const TASK_REASON_MAX_LENGTH = 500;

/**
 * A `WorkReporter` backed by `@clack/prompts`. Renders friendly, hierarchical
 * status to a TTY: an intro banner, a live timer-spinner for the current task,
 * and static log lines for completed tasks.
 *
 * Only one spinner is active at a time — clack's cursor-manipulation renders
 * incorrectly with multiple concurrent spinners. When a second task starts
 * while one is already spinning (concurrency > 1) the existing spinner is
 * parked as a static log line and the new task takes over the live spinner.
 *
 * This is a *presentation* surface only — all diagnostic detail still flows
 * through pino. The two are deliberately separate sinks.
 */
export class ClackReporter implements WorkReporter {
  /** Live spinner state, keyed by taskId. At most one is active. */
  private readonly activeTasks = new Map<string, ActiveTask>();

  /**
   * Clock used for task `startedAt` capture and elapsed-duration labels.
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
    for (const [id, task] of this.activeTasks) {
      if (task.taskLog) {
        task.taskLog.success(this.taskLabel(id, task.phase, task.startedAt), {
          showLog: false,
        });
      } else {
        task.spinner.stop(this.taskLabel(id, task.phase, task.startedAt));
      }
    }
    this.activeTasks.clear();
    clack.outro(message);
  }

  startActivity(message: string): WorkActivity {
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
          `Claimed ${pc.bold(String(event.count))} task${
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

      case "task:starting": {
        // If another task is already spinning, park it as a static line so
        // the new task can take over the live spinner slot.
        this.parkAllSpinners();
        const spin = clack.spinner({ indicator: "timer" });
        spin.start(this.taskLabel(event.taskId, "starting"));
        this.activeTasks.set(event.taskId, {
          spinner: spin,
          startedAt: this.now(),
          phase: "starting",
        });
        return;
      }

      case "task:runtime-launching":
        this.updateSpinner(event.taskId, "launching runtime…");
        return;
      case "task:runtime-cloning":
        this.updateSpinner(event.taskId, "cloning repository…");
        return;
      case "task:runtime-container-starting":
        // Enter taskLog mode: a fixed title line with rolling sub-logs beneath.
        this.beginDevcontainerLog(event.taskId);
        return;
      case "task:runtime-container-progress":
        this.appendDevcontainerLog(
          event.taskId,
          event.kind,
          event.phase,
          event.level ?? "info",
        );
        return;
      case "task:runtime-ai-starting":
        // Devcontainer is up; close its log region and resume the spinner.
        this.endDevcontainerLog(event.taskId, true);
        this.updateSpinner(event.taskId, "starting AI container…");
        return;
      case "task:runtime-ready":
        this.endDevcontainerLog(event.taskId, true);
        this.updateSpinner(event.taskId, "runtime ready");
        return;
      case "task:health-checks-running":
        this.updateSpinner(event.taskId, "running health checks…");
        return;
      case "task:agent-running":
        this.updateSpinner(event.taskId, "agent running");
        return;

      case "task:succeeded": {
        // If the devcontainer log region is still open, close it cleanly first.
        this.endDevcontainerLog(event.taskId, true);
        const task = this.activeTasks.get(event.taskId);
        if (task) {
          const duration = formatElapsed(this.now() - task.startedAt);
          task.spinner.stop(
            pc.green(`Task ${pc.dim(shortId(event.taskId))} succeeded`) +
              pc.dim(` (${duration})`),
          );
          this.activeTasks.delete(event.taskId);
        } else {
          this.success(`Task ${pc.dim(shortId(event.taskId))} succeeded`);
        }
        return;
      }

      case "task:failed": {
        // With raw devcontainer output stripped upstream, the reason is now a
        // clean single-line message. Truncate only as a safety net.
        const reason =
          event.reason.length > TASK_REASON_MAX_LENGTH
            ? `${event.reason.slice(0, TASK_REASON_MAX_LENGTH)}…`
            : event.reason;
        const logHint = this.logFilePath
          ? `\n  ${pc.dim(`Full logs: ${this.logFilePath}`)}`
          : "";
        // Retain the devcontainer sub-logs on failure (showLog: true) so the
        // user can see the last lifecycle phase where it broke.
        this.endDevcontainerLog(event.taskId, false);
        const task = this.activeTasks.get(event.taskId);
        if (task) {
          const duration = formatElapsed(this.now() - task.startedAt);
          task.spinner.error(
            pc.red(`Task ${pc.dim(shortId(event.taskId))} failed`) +
              pc.dim(` (${duration})`) +
              `\n  ${pc.yellow(reason)}${logHint}`,
          );
          this.activeTasks.delete(event.taskId);
        } else {
          this.error(
            `Task ${pc.dim(shortId(event.taskId))} failed` +
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
   * Build the spinner message label for a task.
   * When `startedAt` is provided the elapsed is appended so the parked line
   * captures the final duration at park time.
   */
  private taskLabel(taskId: string, phase: string, startedAt?: number): string {
    const elapsed = startedAt !== undefined
      ? pc.dim(` · ${formatElapsed(this.now() - startedAt)}`)
      : "";
    return `task ${pc.cyan(shortId(taskId))} ${pc.dim(phase)}${elapsed}`;
  }

  /** Update the live spinner message for a task. No-op if the task has no spinner. */
  private updateSpinner(taskId: string, phase: string): void {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    task.phase = phase;
    task.spinner.message(this.taskLabel(taskId, phase));
  }

  /**
   * Enter "devcontainer log" mode for a task: stop the live spinner and start a
   * `taskLog` whose title is the task line and whose body is a rolling window
   * of streamed devcontainer log lines. No-op if the task is unknown or already
   * in this mode.
   */
  private beginDevcontainerLog(taskId: string): void {
    const task = this.activeTasks.get(taskId);
    if (!task || task.taskLog) return;
    task.phase = "starting devcontainer…";
    // Hand the live region from the spinner to the taskLog.
    task.spinner.stop(this.taskLabel(taskId, task.phase));
    task.taskLog = clack.taskLog({
      title: this.taskLabel(taskId, task.phase),
      limit: DEVCONTAINER_LOG_WINDOW,
      retainLog: false,
    });
  }

  /**
   * Feed a devcontainer progress line into the task's open taskLog. Milestones
   * also update the (sticky) title; details only scroll in the body window.
   * No-op if the task has no open taskLog.
   */
  private appendDevcontainerLog(
    taskId: string,
    kind: "milestone" | "detail",
    phase: string,
    level: "info" | "warn" | "error",
  ): void {
    const task = this.activeTasks.get(taskId);
    if (!task?.taskLog) return;
    if (kind === "milestone") {
      task.phase = phase;
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
    task.taskLog.message(line);
  }

  /**
   * Close a task's devcontainer taskLog if open, resuming a fresh spinner so
   * subsequent phases keep their live timer line. On success the streamed body
   * is cleared; on failure (`success=false`) it is retained for debugging.
   * No-op if the task has no open taskLog.
   */
  private endDevcontainerLog(taskId: string, success: boolean): void {
    const task = this.activeTasks.get(taskId);
    if (!task?.taskLog) return;
    const title = this.taskLabel(taskId, task.phase, task.startedAt);
    if (success) {
      task.taskLog.success(title, { showLog: false });
    } else {
      task.taskLog.error(title, { showLog: true });
    }
    task.taskLog = undefined;
    // Resume a live spinner for the post-devcontainer phases.
    const spin = clack.spinner({ indicator: "timer" });
    spin.start(this.taskLabel(taskId, task.phase));
    task.spinner = spin;
  }

  /**
   * Stop all active spinners as static log lines (preserving their elapsed),
   * clearing the map. Used when a new task needs the live-spinner slot.
   */
  private parkAllSpinners(): void {
    for (const [id, task] of this.activeTasks) {
      if (task.taskLog) {
        task.taskLog.success(this.taskLabel(id, task.phase, task.startedAt), {
          showLog: false,
        });
      } else {
        task.spinner.stop(this.taskLabel(id, task.phase, task.startedAt));
      }
    }
    this.activeTasks.clear();
  }
}
