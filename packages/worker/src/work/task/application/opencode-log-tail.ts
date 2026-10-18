import { spawn, type ChildProcess } from "node:child_process";
import { OpencodeLogLineClassifier } from "./opencode-log-line-classifier";
import type { TaskLogShipper } from "./task-log-shipper";

/**
 * Streams the in-container OpenCode `opencode-serve.log` (the AI server's
 * combined stdout/stderr, otherwise trapped inside the devcontainer)
 * line-by-line into a {@link TaskLogShipper} as the `ai-server` stream,
 * with each line's severity assigned by an {@link OpencodeLogLineClassifier}.
 *
 * For container runs, uses `docker exec <container> tail -n +1 -F <logPath>` so
 * it emits the existing contents and then follows appends inside the container.
 * For `no_workspace` (host) runs, `containerId` is `null` and the log file lives
 * directly on the host, so it uses a plain `tail -n +1 -F <logPath>` on the host
 * instead. Best-effort either way: spawn failures are reported via `onError` and
 * never throw, since logging must not break the task.
 */
export class OpencodeLogTail {
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private stopped = false;
  private readonly classifier = new OpencodeLogLineClassifier();

  constructor(
    private readonly deps: {
      /** `null` for host (`no_workspace`) runs — tails the host file directly. */
      containerId: string | null;
      logPath: string;
      shipper: TaskLogShipper;
      // eslint-disable-next-line local/no-unknown-parameter-type
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.child !== null || this.stopped) {
      return;
    }
    try {
      // Wait briefly for the file to appear, then follow from the top.
      const tailScript =
        `for i in $(seq 1 30); do [ -f "${this.deps.logPath}" ] && break; sleep 1; done; ` +
        `tail -n +1 -F "${this.deps.logPath}" 2>/dev/null`;
      const [command, args] =
        this.deps.containerId === null
          ? (["sh", ["-lc", tailScript]] as const)
          : ([
              "docker",
              ["exec", this.deps.containerId, "sh", "-lc", tailScript],
            ] as const);
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "ignore"],
      });
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
      this.ship(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private ship(line: string): void {
    const { content, level } = this.classifier.classify(line);
    this.deps.shipper.enqueue("ai-server", content, undefined, level);
  }

  stop(): void {
    this.stopped = true;
    if (this.stdoutBuffer.length > 0) {
      this.ship(this.stdoutBuffer);
      this.stdoutBuffer = "";
    }
    if (this.child !== null) {
      this.child.kill();
      this.child = null;
    }
  }
}
