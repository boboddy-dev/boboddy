/**
 * Unit tests for the per-mirror lock in {@link GitCliMirrorCache} against REAL
 * local git repos. Pid liveness, the clock and the wait/poll/stale timings are
 * injected so the tests stay fast.
 */
import {
  mkdir,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { git } from "./git-test-fixtures";
import { createLogger, setupFixture } from "./git-mirror-cache-fixtures";

const DEAD_PID = 2_000_000_000;
const FIVE_MINUTES_MS = 5 * 60_000;

type LockOwnerFile = { pid: number; createdAt: number; token?: string };

async function plantLock(
  lockPath: string,
  owner: LockOwnerFile | null,
  ageMs = 0,
): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  if (owner !== null) {
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner));
  }
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await utimes(lockPath, then, then);
  }
}

async function readOwner(lockPath: string): Promise<LockOwnerFile> {
  const raw = await readFile(path.join(lockPath, "owner.json"), "utf8");
  return JSON.parse(raw) as LockOwnerFile;
}

async function lockExists(lockPath: string): Promise<boolean> {
  return (await readdir(path.dirname(lockPath))).includes(
    path.basename(lockPath),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("GitCliMirrorCache locking", () => {
  test.concurrent(
    "two concurrent first-time prepares on one URL both succeed, one at a time",
    async () => {
      const fx = await setupFixture();
      const events: string[] = [];
      const useMirror = async (name: string) => {
        const prepared = await fx.cache.prepare(fx.remote, {});
        if (prepared === null) {
          return null;
        }
        events.push(`${name}:acquired`);
        await sleep(50);
        const head = await git(prepared.mirrorPath, [
          "rev-parse",
          "refs/heads/main",
        ]);
        events.push(`${name}:released`);
        await prepared.release();
        return head;
      };
      try {
        const [a, b] = await Promise.all([useMirror("a"), useMirror("b")]);
        const expected = await git(fx.seed, ["rev-parse", "HEAD"]);

        expect(a).toBe(expected);
        expect(b).toBe(expected);
        const winner = events[0]?.startsWith("a") ? "a" : "b";
        const loser = winner === "a" ? "b" : "a";
        expect(events).toEqual([
          `${winner}:acquired`,
          `${winner}:released`,
          `${loser}:acquired`,
          `${loser}:released`,
        ]);
        expect(await git(fx.mirrorPath, ["fsck", "--no-progress"])).toBe("");
        expect(await readdir(fx.cacheDir)).toEqual([
          path.basename(fx.mirrorPath),
        ]);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a second prepare waits for the first release even from the same pid",
    async () => {
      const fx = await setupFixture();
      try {
        const first = await fx.cache.prepare(fx.remote, {});
        let secondSettled = false;
        const second = fx.cache.prepare(fx.remote, {}).then((prepared) => {
          secondSettled = true;
          return prepared;
        });

        await sleep(150);
        expect(secondSettled).toBe(false);
        expect((await readOwner(fx.lockPath)).pid).toBe(process.pid);

        await first?.release();
        const prepared = await second;

        expect(prepared?.mirrorPath).toBe(fx.mirrorPath);
        await prepared?.release();
        expect(await lockExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "prepare returns with the lock held by this process",
    async () => {
      const fx = await setupFixture();
      try {
        const before = Date.now();
        const prepared = await fx.cache.prepare(fx.remote, {});

        const owner = await readOwner(fx.lockPath);
        expect(owner.pid).toBe(process.pid);
        expect(owner.createdAt).toBeGreaterThanOrEqual(before);
        await prepared?.release();
        expect(await lockExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent("a lock whose pid is dead is stolen", async () => {
    const fx = await setupFixture({
      isPidAlive: (pid) => pid !== DEAD_PID,
    });
    const { lines, logger } = createLogger();
    try {
      await mkdir(fx.cacheDir, { recursive: true });
      await plantLock(fx.lockPath, { pid: DEAD_PID, createdAt: Date.now() });

      const prepared = await fx.cache.prepare(fx.remote, { logger });

      expect(prepared?.mirrorPath).toBe(fx.mirrorPath);
      expect((await readOwner(fx.lockPath)).pid).toBe(process.pid);
      expect(lines.map((l) => l.message).join("\n")).toContain("stale lock");
      await prepared?.release();
      expect(await readdir(fx.cacheDir)).toEqual([
        path.basename(fx.mirrorPath),
      ]);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.concurrent(
    "a lock held by an exited process is stolen with the default liveness check",
    async () => {
      const fx = await setupFixture();
      try {
        const child = Bun.spawn([process.execPath, "-e", ""]);
        await child.exited;
        await mkdir(fx.cacheDir, { recursive: true });
        await plantLock(fx.lockPath, {
          pid: child.pid,
          createdAt: Date.now(),
        });

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).not.toBeNull();
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a lock older than the stale threshold is stolen even if its pid is alive",
    async () => {
      const clock = 1_000_000_000_000;
      const fx = await setupFixture({
        isPidAlive: () => true,
        now: () => clock,
        lockStaleMs: FIVE_MINUTES_MS,
      });
      try {
        await mkdir(fx.cacheDir, { recursive: true });
        await plantLock(fx.lockPath, {
          pid: process.pid,
          createdAt: clock - FIVE_MINUTES_MS - 1,
        });

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).not.toBeNull();
        expect((await readOwner(fx.lockPath)).createdAt).toBe(clock);
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a live lock younger than the stale threshold is not stolen",
    async () => {
      const clock = 1_000_000_000_000;
      const fx = await setupFixture({
        isPidAlive: () => true,
        now: () => clock,
        lockStaleMs: FIVE_MINUTES_MS,
        lockWaitTimeoutMs: 80,
      });
      try {
        await mkdir(fx.cacheDir, { recursive: true });
        const owner = { pid: process.pid, createdAt: clock - 1000 };
        await plantLock(fx.lockPath, owner);

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).toBeNull();
        expect(await readOwner(fx.lockPath)).toEqual(owner);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a lock dir without owner.json is stolen when its mtime is stale",
    async () => {
      const fx = await setupFixture({ lockStaleMs: 60_000 });
      try {
        await mkdir(fx.cacheDir, { recursive: true });
        await plantLock(fx.lockPath, null, 120_000);

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).not.toBeNull();
        expect((await readOwner(fx.lockPath)).pid).toBe(process.pid);
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a lock dir without owner.json and a fresh mtime is respected",
    async () => {
      const fx = await setupFixture({
        lockStaleMs: 60_000,
        lockWaitTimeoutMs: 80,
      });
      try {
        await mkdir(fx.cacheDir, { recursive: true });
        await plantLock(fx.lockPath, null);

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).toBeNull();
        expect(await lockExists(fx.lockPath)).toBe(true);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a held live lock makes prepare return null after the wait timeout without throwing",
    async () => {
      const fx = await setupFixture({ lockWaitTimeoutMs: 100 });
      const { lines, logger } = createLogger();
      try {
        const holder = await fx.cache.prepare(fx.remote, {});
        const started = performance.now();

        const second = await fx.cache.prepare(fx.remote, { logger });

        expect(second).toBeNull();
        expect(performance.now() - started).toBeGreaterThanOrEqual(90);
        const fallbacks = lines.filter((l) =>
          l.message.startsWith("git-cache: falling back to plain clone ("),
        );
        expect(fallbacks).toHaveLength(1);
        expect(fallbacks[0]?.message).toContain("lock");
        expect((await readOwner(fx.lockPath)).pid).toBe(process.pid);
        await holder?.release();
        expect(await lockExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "several waiters racing to steal one stale lock never hold it together",
    async () => {
      const fx = await setupFixture({
        isPidAlive: (pid) => pid !== DEAD_PID,
        lockPollIntervalMs: 5,
        lockWaitTimeoutMs: 30_000,
      });
      let active = 0;
      let maxActive = 0;
      const useMirror = async () => {
        const prepared = await fx.cache.prepare(fx.remote, {});
        if (prepared === null) {
          return false;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active -= 1;
        await prepared.release();
        return true;
      };
      try {
        await mkdir(fx.cacheDir, { recursive: true });
        await plantLock(fx.lockPath, { pid: DEAD_PID, createdAt: Date.now() });

        const results = await Promise.all(
          Array.from({ length: 5 }, () => useMirror()),
        );

        expect(results).toEqual([true, true, true, true, true]);
        expect(maxActive).toBe(1);
        expect(await lockExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a steal claim orphaned by a crashed stealer does not wedge the lock",
    async () => {
      const fx = await setupFixture({
        isPidAlive: (pid) => pid !== DEAD_PID,
      });
      try {
        await mkdir(fx.cacheDir, { recursive: true });
        await plantLock(fx.lockPath, { pid: DEAD_PID, createdAt: Date.now() });
        await plantLock(`${fx.lockPath}.steal`, null, 10 * 60_000);

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).not.toBeNull();
        await prepared?.release();
        expect(await readdir(fx.cacheDir)).toEqual([
          path.basename(fx.mirrorPath),
        ]);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a prepare that falls back releases the lock it took",
    async () => {
      const fx = await setupFixture();
      try {
        await rm(fx.remote, { recursive: true, force: true });

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).toBeNull();
        expect(await lockExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "release removes the lock only while this prepare still owns it",
    async () => {
      const fx = await setupFixture();
      try {
        const prepared = await fx.cache.prepare(fx.remote, {});
        const thief = {
          pid: process.pid,
          createdAt: Date.now() + 1,
          token: "someone-else",
        };
        await writeFile(
          path.join(fx.lockPath, "owner.json"),
          JSON.stringify(thief),
        );

        await prepared?.release();

        expect(await readOwner(fx.lockPath)).toEqual(thief);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "release is idempotent and never removes a later owner's lock",
    async () => {
      const fx = await setupFixture();
      try {
        const first = await fx.cache.prepare(fx.remote, {});
        await first?.release();
        const second = await fx.cache.prepare(fx.remote, {});
        const ownerBefore = await readOwner(fx.lockPath);

        await first?.release();

        expect(await readOwner(fx.lockPath)).toEqual(ownerBefore);
        await second?.release();
        await second?.release();
        expect(await lockExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );
});
