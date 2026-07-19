/**
 * Unit test for the CONTAINER branch of {@link captureOpencodeLogPreview}.
 *
 * Container runs keep HOME (and therefore the OpenCode serve log directory) on
 * the container's native overlay filesystem, so the log is no longer reachable
 * from the host fs and must be read via `docker exec`. The function accepts an
 * injectable `runDockerExec` seam so the container path is exercised
 * deterministically WITHOUT a real Docker daemon.
 *
 * Coverage:
 *   1. With a `containerId`, it shells out via `docker exec` — an `ls -1` to list
 *      files and a `tail -c 2000` per file — and returns the tailed content.
 *   2. With `containerId: null`, it does NOT call `runDockerExec`; it reads the
 *      host directory instead.
 *   3. On a docker failure it degrades gracefully to the single `Unavailable:`
 *      entry rather than throwing.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureOpencodeLogPreview } from "../../../../src/work/step-execution/application/process-project-work-monitor-helpers";

describe("captureOpencodeLogPreview container branch (docker exec)", () => {
  test("lists files and tails each via docker exec, returning the content", async () => {
    const calls: string[][] = [];
    const runDockerExec = (args: string[]): Promise<{ stdout: string }> => {
      calls.push(args);
      const script = args[args.length - 1] ?? "";
      if (script.startsWith("ls -1")) {
        return Promise.resolve({ stdout: "a.log\nb.log\n" });
      }
      if (script.includes("a.log")) {
        return Promise.resolve({ stdout: "contents-of-a" });
      }
      return Promise.resolve({ stdout: "contents-of-b" });
    };

    const result = await captureOpencodeLogPreview(
      { logDirectory: "/home/agent/.boboddy-log", containerId: "container-123" },
      runDockerExec,
    );

    // First call is the `ls`; it must go through `docker exec <id> sh -lc`.
    const listCall = calls[0];
    expect(listCall).toBeDefined();
    expect(listCall?.slice(0, 5)).toEqual([
      "exec",
      "container-123",
      "sh",
      "-lc",
      "ls -1 '/home/agent/.boboddy-log' 2>/dev/null",
    ]);

    // Each file is tailed with `tail -c 2000`.
    const tailScripts = calls
      .slice(1)
      .map((args) => args[args.length - 1] ?? "");
    expect(
      tailScripts.some((s) =>
        s.includes("tail -c 2000 '/home/agent/.boboddy-log/a.log'"),
      ),
    ).toBe(true);

    expect(result).toEqual([
      { file: "a.log", contentPreview: "contents-of-a" },
      { file: "b.log", contentPreview: "contents-of-b" },
    ]);
  });

  test("degrades to a single Unavailable entry when docker exec fails", async () => {
    const runDockerExec = (): Promise<{ stdout: string }> =>
      Promise.reject(new Error("docker daemon not running"));

    const result = await captureOpencodeLogPreview(
      { logDirectory: "/home/agent/.boboddy-log", containerId: "container-123" },
      runDockerExec,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.file).toBe("<opencode-log-dir>");
    expect(result[0]?.contentPreview).toContain("Unavailable:");
    expect(result[0]?.contentPreview).toContain("docker daemon not running");
  });
});

describe("captureOpencodeLogPreview host branch (containerId: null)", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(path.join(os.tmpdir(), "opencode-log-preview-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  test("reads the host directory and never invokes docker exec", async () => {
    await writeFile(path.join(logDir, "opencode-serve.log"), "host-line\n", "utf8");

    let dockerCalled = false;
    const runDockerExec = (): Promise<{ stdout: string }> => {
      dockerCalled = true;
      return Promise.resolve({ stdout: "" });
    };

    const result = await captureOpencodeLogPreview(
      { logDirectory: logDir, containerId: null },
      runDockerExec,
    );

    expect(dockerCalled).toBe(false);
    expect(result).toEqual([
      { file: "opencode-serve.log", contentPreview: "host-line\n" },
    ]);
  });
});
