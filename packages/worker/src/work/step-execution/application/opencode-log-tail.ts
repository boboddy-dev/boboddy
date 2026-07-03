import { spawn, type ChildProcess } from "node:child_process";
import type { LogLevel, StepExecutionLogShipper } from "./step-execution-log-shipper";

/**
 * Infer a severity for a raw OpenCode serve-log line so the shipper can filter
 * low-signal output. OpenCode lines are unstructured, so this is heuristic:
 * explicit error/warn markers map to those levels; everything else is treated
 * as `debug` (i.e. dropped from the durable feed by default) since the raw AI
 * server log is verbose and not product data. The structured conversation
 * stream carries the agent transcript users actually see.
 */
const classifyAiServerLine = (line: string): LogLevel => {
  const lower = line.toLowerCase();
  if (/\b(error|exception|fatal|panic|unhandled)\b/.test(lower)) {
    return "error";
  }
  if (/\b(warn|warning|deprecated)\b/.test(lower)) {
    return "warn";
  }
  return "debug";
};

/**
 * Streams the in-container OpenCode `opencode-serve.log` (the AI server's
 * combined stdout/stderr, otherwise trapped inside the devcontainer)
 * line-by-line into a {@link StepExecutionLogShipper} as the `ai-server` stream.
 *
 * Uses `docker exec <container> tail -n +1 -F <logPath>` so it emits the
 * existing contents and then follows appends, surviving the file not yet
 * existing. Best-effort: spawn failures are reported via `onError` and never
 * throw, since logging must not break step execution.
 */
export class OpencodeLogTail {
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private stopped = false;

  constructor(
    private readonly deps: {
      containerId: string;
      logPath: string;
      shipper: StepExecutionLogShipper;
      // eslint-disable-next-line local/no-unknown-parameter-type
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.child !== null || this.stopped) {
      return;
    }
    try {
      const child = spawn(
        "docker",
        [
          "exec",
          this.deps.containerId,
          "sh",
          "-lc",
          // Wait briefly for the file to appear, then follow from the top.
          `for i in $(seq 1 30); do [ -f "${this.deps.logPath}" ] && break; sleep 1; done; ` +
            `tail -n +1 -F "${this.deps.logPath}" 2>/dev/null`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.handleChunk(chunk);
      });
      child.on("error", (error) => {
        this.deps.onError?.(error);
      });
      this.child = child;
    } catch (error) {
      this.deps.onError?.(error);
    }
  }

  private handleChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.deps.shipper.enqueue(
        "ai-server",
        line,
        undefined,
        classifyAiServerLine(line),
      );
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.stdoutBuffer.length > 0) {
      this.deps.shipper.enqueue(
        "ai-server",
        this.stdoutBuffer,
        undefined,
        classifyAiServerLine(this.stdoutBuffer),
      );
      this.stdoutBuffer = "";
    }
    if (this.child !== null) {
      this.child.kill();
      this.child = null;
    }
  }
}
