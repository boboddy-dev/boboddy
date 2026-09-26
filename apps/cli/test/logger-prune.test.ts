import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneLogDir } from "../src/lib/logger";

/**
 * `pruneLogDir` runs on every CLI invocation (`ensureLogDir`), so it has to be
 * cheap and safe against whatever previous runs left behind — including
 * concurrent runs still writing. Exercised against a real temp directory
 * rather than mocked `fs`, since the function's whole job is filesystem
 * bookkeeping (mtimes, sizes, deletion) that a mock would just restate.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "boboddy-log-prune-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeLogFile(
  name: string,
  { content = "log line\n", ageMs = 0 }: { content?: string; ageMs?: number } = {},
): Promise<void> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, content);
  const mtime = new Date(Date.now() - ageMs);
  await utimes(filePath, mtime, mtime);
}

describe("pruneLogDir", () => {
  test("leaves a small, fresh, non-empty directory untouched", async () => {
    await writeLogFile("worker-a.log");
    await writeLogFile("worker-b.log");

    await pruneLogDir({ dir, maxFiles: 20, maxAgeMs: 7 * DAY_MS });

    expect((await readdir(dir)).sort()).toEqual(["worker-a.log", "worker-b.log"]);
  });

  test("deletes empty files unconditionally, regardless of age or count", async () => {
    await writeLogFile("worker-empty.log", { content: "" });
    await writeLogFile("worker-nonempty.log");

    await pruneLogDir({ dir, maxFiles: 20, maxAgeMs: 7 * DAY_MS });

    expect(await readdir(dir)).toEqual(["worker-nonempty.log"]);
  });

  test("keeps only the newest N files once past the count cap", async () => {
    await writeLogFile("worker-old.log", { ageMs: 3000 });
    await writeLogFile("worker-mid.log", { ageMs: 2000 });
    await writeLogFile("worker-new.log", { ageMs: 1000 });

    await pruneLogDir({ dir, maxFiles: 2, maxAgeMs: 7 * DAY_MS });

    expect((await readdir(dir)).sort()).toEqual(["worker-mid.log", "worker-new.log"]);
  });

  test("deletes files older than the age cap even under the count cap", async () => {
    await writeLogFile("worker-stale.log", { ageMs: 8 * DAY_MS });
    await writeLogFile("worker-fresh.log", { ageMs: DAY_MS });

    await pruneLogDir({ dir, maxFiles: 20, maxAgeMs: 7 * DAY_MS });

    expect(await readdir(dir)).toEqual(["worker-fresh.log"]);
  });

  test("ignores files that don't match the worker-*.log naming pattern", async () => {
    await writeFile(path.join(dir, "not-a-worker-log.txt"), "irrelevant");
    await writeLogFile("worker-a.log", { content: "" });

    await pruneLogDir({ dir, maxFiles: 0, maxAgeMs: 0 });

    expect(await readdir(dir)).toEqual(["not-a-worker-log.txt"]);
  });

  test("is a no-op when the directory doesn't exist", async () => {
    await rm(dir, { recursive: true, force: true });

    // Should resolve without throwing, even though `dir` is gone.
    await pruneLogDir({ dir });
  });

  test("never deletes excludePath, even if empty, stale, and past the count cap", async () => {
    // Regression case: `ensureLogDir` calls `pruneLogDir` *after* the current
    // run's own file already exists (the module-level `cliLogger` singleton
    // in logger.ts opens it at import time). Without `excludePath`, the
    // empty-file rule would delete a run's own log before it ever got a
    // chance to write to it.
    const ownFilePath = path.join(dir, "worker-own.log");
    await writeLogFile("worker-own.log", { content: "", ageMs: 30 * DAY_MS });

    await pruneLogDir({ dir, maxFiles: 0, maxAgeMs: 0, excludePath: ownFilePath });

    expect(await readdir(dir)).toEqual(["worker-own.log"]);
  });
});
