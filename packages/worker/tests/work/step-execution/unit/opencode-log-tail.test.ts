/**
 * Unit test for {@link OpencodeLogTail} in HOST-FILE mode (`containerId: null`),
 * the `no_workspace` path. Two things matter:
 *
 *   1. It must NOT shell out to `docker` — for host runs the log file lives on
 *      the host and is tailed directly.
 *   2. It really follows the host file and ships appended lines through the
 *      shipper. `tail -F` is available on the darwin/CI shells this repo runs on,
 *      so a real, fast tail is exercised end-to-end against a temp file.
 *
 * Approach: the source imports `spawn` as a bound named import, so spying on the
 * `child_process` namespace can't reliably intercept it. Instead we assert the
 * host-file branch through observable behavior — a REAL `sh`/`tail` follows the
 * host file and ships its lines. This works with no Docker present at all, which
 * is exactly the host-mode guarantee (`docker exec` would require the daemon and
 * fail); a successful real tail therefore proves the non-docker branch was taken.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpencodeLogTail } from "../../../../src/work/step-execution/application/opencode-log-tail";
import type {
  LogLevel,
  StepExecutionLogShipper,
} from "../../../../src/work/step-execution/application/step-execution-log-shipper";

type EnqueuedLine = { stream: string; content: string; level: LogLevel };

/** Minimal shipper fake that records enqueued lines. */
function createFakeShipper(): {
  shipper: Pick<StepExecutionLogShipper, "enqueue">;
  lines: EnqueuedLine[];
} {
  const lines: EnqueuedLine[] = [];
  const shipper: Pick<StepExecutionLogShipper, "enqueue"> = {
    enqueue: (stream, content, _ts, level: LogLevel) => {
      lines.push({ stream, content, level });
    },
  };
  return { shipper, lines };
}

describe("OpencodeLogTail host-file mode (containerId: null)", () => {
  let logDir: string;
  let logPath: string;
  let tail: OpencodeLogTail | null = null;

  beforeEach(async () => {
    logDir = await mkdtemp(path.join(os.tmpdir(), "opencode-log-tail-"));
    logPath = path.join(logDir, "opencode-serve.log");
  });

  afterEach(async () => {
    tail?.stop();
    tail = null;
    await rm(logDir, { recursive: true, force: true });
  });

  test("tails the real host file and ships appended lines to the shipper (no docker required)", async () => {
    await writeFile(logPath, "first line\n", "utf8");

    const { shipper, lines } = createFakeShipper();
    tail = new OpencodeLogTail({
      containerId: null,
      logPath,
      shipper: shipper as StepExecutionLogShipper,
    });
    tail.start();

    // Give `tail -n +1 -F` time to emit the existing content, then append more.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(logPath, "first line\nsecond line\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 400));

    const contents = lines.map((l) => l.content);
    expect(contents).toContain("first line");
    expect(contents).toContain("second line");
    // Everything is shipped under the `ai-server` stream.
    expect(lines.every((l) => l.stream === "ai-server")).toBe(true);
  });
});
