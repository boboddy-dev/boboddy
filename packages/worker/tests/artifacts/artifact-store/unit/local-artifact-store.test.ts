import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalArtifactStore } from "../../../../src/artifacts/artifact-store/infra/local-artifact-store";

/**
 * `LocalArtifactStore.prune` mirrors `pruneLogDir`'s shape (see
 * `apps/cli/src/lib/logger.ts` / `apps/cli/test/logger-prune.test.ts`) at
 * directory instead of file granularity, so it's exercised the same way:
 * real temp directories, controlled mtimes via `utimes`, no mocked `fs`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), "boboddy-artifact-prune-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

async function writeStepDir(
  stepExecutionId: string,
  {
    bytes = 100,
    ageMs = 0,
    nested = false,
  }: { bytes?: number; ageMs?: number; nested?: boolean } = {},
): Promise<string> {
  const dirPath = path.join(baseDir, stepExecutionId);
  await mkdir(dirPath, { recursive: true });
  const filePath = nested
    ? (await mkdir(path.join(dirPath, "nested"), { recursive: true }),
      path.join(dirPath, "nested", "trace.zip"))
    : path.join(dirPath, "trace.zip");
  await writeFile(filePath, Buffer.alloc(bytes, "a"));
  const mtime = new Date(Date.now() - ageMs);
  // The directory's OWN mtime is the recency proxy `prune` reads — bump it
  // explicitly rather than relying on however the OS timestamps a `mkdir`,
  // since writing into a nested subfolder does not reliably touch the
  // parent's mtime on every platform.
  await utimes(dirPath, mtime, mtime);
  return dirPath;
}

async function listStepDirs(): Promise<string[]> {
  return (await readdir(baseDir)).sort();
}

describe("LocalArtifactStore.prune", () => {
  test("is a no-op when retention is undefined (local-only mode)", async () => {
    await writeStepDir("step-a", { bytes: 10_000, ageMs: 30 * DAY_MS });
    const store = new LocalArtifactStore(baseDir);

    await store.prune();

    expect(await listStepDirs()).toEqual(["step-a"]);
  });

  test("is a no-op when baseDir doesn't exist, even with retention configured", async () => {
    const missingDir = path.join(baseDir, "does-not-exist");
    const store = new LocalArtifactStore(missingDir, {
      retention: { localMaxBytes: 1000, localMaxAgeDays: 7 },
    });

    // Should resolve without throwing, even though `missingDir` is gone.
    await store.prune();
  });

  test("leaves everything untouched when under both the size and age caps", async () => {
    await writeStepDir("step-a", { bytes: 100, ageMs: DAY_MS });
    await writeStepDir("step-b", { bytes: 100, ageMs: 2 * DAY_MS });
    const store = new LocalArtifactStore(baseDir, {
      retention: { localMaxBytes: 10_000, localMaxAgeDays: 7 },
    });

    await store.prune();

    expect(await listStepDirs()).toEqual(["step-a", "step-b"]);
  });

  test("evicts oldest-mtime-first until under the size budget", async () => {
    await writeStepDir("step-old", { bytes: 500, ageMs: 3000 });
    await writeStepDir("step-mid", { bytes: 500, ageMs: 2000 });
    await writeStepDir("step-new", { bytes: 500, ageMs: 1000 });
    const store = new LocalArtifactStore(baseDir, {
      retention: { localMaxBytes: 900, localMaxAgeDays: 365 },
    });

    await store.prune();

    // Total is 1500; evicting the single oldest (step-old, 500 bytes) drops
    // the remaining total to 1000, which is still over budget, so the next
    // oldest (step-mid) must also go, leaving only step-new (500 <= 900).
    expect(await listStepDirs()).toEqual(["step-new"]);
  });

  test("evicts a directory past the age cap even though total size is under budget", async () => {
    await writeStepDir("step-stale", { bytes: 100, ageMs: 20 * DAY_MS });
    await writeStepDir("step-fresh", { bytes: 100, ageMs: DAY_MS });
    const store = new LocalArtifactStore(baseDir, {
      retention: { localMaxBytes: 1_000_000, localMaxAgeDays: 14 },
    });

    await store.prune();

    expect(await listStepDirs()).toEqual(["step-fresh"]);
  });

  test("both-bars interaction: an over-age directory is evicted even if it's individually within budget, without dragging down an unrelated within-budget-and-within-age directory", async () => {
    // step-stale is small and would fit the size budget on its own, but is
    // past the age cap — must be evicted regardless of size.
    await writeStepDir("step-stale", { bytes: 50, ageMs: 20 * DAY_MS });
    // step-fresh clears both bars and must survive.
    await writeStepDir("step-fresh", { bytes: 50, ageMs: DAY_MS });
    const store = new LocalArtifactStore(baseDir, {
      retention: { localMaxBytes: 1_000_000, localMaxAgeDays: 14 },
    });

    await store.prune();

    expect(await listStepDirs()).toEqual(["step-fresh"]);
  });

  test("both-bars interaction: evicting for size doesn't skip a within-budget directory just because an older, over-age directory also needs removal", async () => {
    // Oldest, over budget AND over age — must go on both counts.
    await writeStepDir("step-oldest", { bytes: 900, ageMs: 20 * DAY_MS });
    // Middle: within age and, once step-oldest alone is evicted, the
    // remaining total (100+100=200) already sits exactly at the 200-byte
    // budget — exercises that this within-budget, within-age directory is
    // correctly left alone rather than swept away along with step-oldest.
    await writeStepDir("step-mid", { bytes: 100, ageMs: 5 * DAY_MS });
    // Newest, small, within budget and within age — must survive.
    await writeStepDir("step-newest", { bytes: 100, ageMs: DAY_MS });
    const store = new LocalArtifactStore(baseDir, {
      retention: { localMaxBytes: 200, localMaxAgeDays: 14 },
    });

    await store.prune();

    expect(await listStepDirs()).toEqual(["step-mid", "step-newest"]);
  });

  test("sums nested subdirectory file sizes correctly (flat-layout assumption doesn't break on a nested example)", async () => {
    await writeStepDir("step-nested", {
      bytes: 5000,
      ageMs: DAY_MS,
      nested: true,
    });
    const store = new LocalArtifactStore(baseDir, {
      retention: { localMaxBytes: 1000, localMaxAgeDays: 365 },
    });

    await store.prune();

    // 5000 bytes (nested) exceeds the 1000-byte budget, so it's still
    // evicted correctly — proving the size sum reaches into the nested file
    // rather than only seeing the (otherwise-empty) top-level directory.
    expect(await listStepDirs()).toEqual([]);
  });
});
