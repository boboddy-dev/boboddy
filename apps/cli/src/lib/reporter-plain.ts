import type { WorkEvent, WorkReporter, WorkTask } from "./reporter-types";

/**
 * A plain, non-interactive reporter for non-TTY contexts (pipes, CI). Emits
 * one human-readable line per milestone to stderr — no spinners, no ANSI — so
 * stdout stays clean for machine-readable output and logs.
 */
export class PlainReporter implements WorkReporter {
  constructor(private readonly logFilePath?: string) {}

  private line(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  start(title: string): void {
    this.line(`▸ ${title}`);
    if (this.logFilePath) {
      this.line(`· logs → ${this.logFilePath}`);
    }
  }

  finish(message: string): void {
    this.line(`✓ ${message}`);
  }

  startTask(message: string): WorkTask {
    this.line(`… ${message}`);
    return {
      update: (next) => { this.line(`… ${next}`); },
      succeed: (next) => { this.line(`✓ ${next ?? message}`); },
      fail: (next) => { this.line(`✗ ${next ?? message}`); },
    };
  }

  info(message: string): void {
    this.line(`· ${message}`);
  }

  success(message: string): void {
    this.line(`✓ ${message}`);
  }

  warn(message: string): void {
    this.line(`! ${message}`);
  }

  error(message: string): void {
    this.line(`✗ ${message}`);
  }

  event(event: WorkEvent): void {
    switch (event.type) {
      case "worker:starting":
        this.info(`starting (concurrency ${String(event.concurrency)})`);
        return;
      case "worker:ready":
        this.info("worker ready");
        return;
      case "worker:claimed":
        this.info(`claimed ${String(event.count)} step(s)`);
        return;
      case "worker:complete":
        this.success(
          `run complete: ${String(event.processed)} processed, ${String(
            event.skipped,
          )} skipped`,
        );
        return;
      case "step:starting":
        this.info(`step ${event.stepExecutionId} started`);
        return;
      case "step:succeeded":
        this.success(`step ${event.stepExecutionId} succeeded`);
        return;
      case "step:failed":
        this.error(`step ${event.stepExecutionId} failed: ${event.reason}`);
        if (this.logFilePath) {
          this.line(`· full logs: ${this.logFilePath}`);
        }
        return;
      // Off-TTY: surface milestones (they explain the otherwise-silent
      // multi-minute pause) and any warn/error detail lines (the actual failure
      // output), but drop info-level detail noise to keep CI logs readable.
      case "step:runtime-container-progress":
        if (event.kind === "milestone") {
          this.info(`devcontainer: ${event.phase}`);
        } else if (event.level === "error") {
          this.error(`devcontainer: ${event.phase}`);
        } else if (event.level === "warn") {
          this.warn(`devcontainer: ${event.phase}`);
        }
        return;
      // Intermediate / chatty states are intentionally dropped off-TTY.
      case "worker:polling":
      case "worker:idle":
      case "step:runtime-launching":
      case "step:runtime-cloning":
      case "step:runtime-container-starting":
      case "step:runtime-ai-starting":
      case "step:runtime-ready":
      case "step:health-checks-running":
      case "step:agent-running":
        return;
    }
  }
}
