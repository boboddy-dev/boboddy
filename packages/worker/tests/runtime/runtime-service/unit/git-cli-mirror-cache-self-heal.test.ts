/**
 * Unit tests for {@link GitCliMirrorCache} self-heal against REAL local git
 * repos: a damaged mirror is deleted and recreated once inside `prepare`, a
 * network failure never deletes a good mirror, and the lock is always released.
 */
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { git } from "./git-test-fixtures";
import {
  createLogger,
  setupFixture,
  type LogLine,
} from "./git-mirror-cache-fixtures";

const RECREATING = /^git-cache: mirror corrupt \(.+\), recreating$/;

type Fixture = Awaited<ReturnType<typeof setupFixture>>;

async function plantGarbageDir(mirrorPath: string): Promise<void> {
  await mkdir(path.join(mirrorPath, "nested"), { recursive: true });
  await writeFile(path.join(mirrorPath, "random.bin"), "not a repository");
  await writeFile(path.join(mirrorPath, "HEAD"), "garbage");
}

async function corruptEveryObject(mirrorPath: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else {
        await chmod(entryPath, 0o644);
        await writeFile(entryPath, "garbage");
      }
    }
  };
  await walk(path.join(mirrorPath, "objects"));
}

async function expectHealthyMirror(fx: Fixture): Promise<void> {
  expect(await git(fx.mirrorPath, ["rev-parse", "--is-bare-repository"])).toBe(
    "true",
  );
  expect(await git(fx.mirrorPath, ["fsck", "--no-progress"])).toBe("");
  expect(await git(fx.mirrorPath, ["rev-parse", "refs/heads/main"])).toBe(
    await git(fx.seed, ["rev-parse", "HEAD"]),
  );
  expect(await git(fx.mirrorPath, ["symbolic-ref", "HEAD"])).toBe(
    "refs/heads/main",
  );
}

async function onlyMirrorLeft(fx: Fixture): Promise<void> {
  expect(await readdir(fx.cacheDir)).toEqual([path.basename(fx.mirrorPath)]);
}

function messages(lines: LogLine[]): string[] {
  return lines.map((line) => line.message);
}

describe("GitCliMirrorCache self-heal", () => {
  test.concurrent(
    "a garbage directory at the mirror path is replaced and prepare succeeds",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await plantGarbageDir(fx.mirrorPath);

        const prepared = await fx.cache.prepare(fx.remote, { logger });

        expect(prepared?.mirrorPath).toBe(fx.mirrorPath);
        await expectHealthyMirror(fx);
        const recreating = lines.filter((l) => RECREATING.test(l.message));
        expect(recreating).toHaveLength(1);
        expect(recreating[0]?.scope).toBe("git-cache");
        expect(messages(lines).join("\n")).not.toContain("falling back");
        await prepared?.release();
        await onlyMirrorLeft(fx);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent("a plain file at the mirror path is replaced", async () => {
    const fx = await setupFixture();
    const { lines, logger } = createLogger();
    try {
      await mkdir(fx.cacheDir, { recursive: true });
      await writeFile(fx.mirrorPath, "i am a file, not a repo");

      const prepared = await fx.cache.prepare(fx.remote, { logger });

      expect(prepared).not.toBeNull();
      await expectHealthyMirror(fx);
      expect(lines.filter((l) => RECREATING.test(l.message))).toHaveLength(1);
      await prepared?.release();
      await onlyMirrorLeft(fx);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.concurrent(
    "an empty directory at the mirror path is replaced",
    async () => {
      const fx = await setupFixture();
      try {
        await mkdir(fx.mirrorPath, { recursive: true });

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).not.toBeNull();
        await expectHealthyMirror(fx);
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a dangling symlink at the mirror path is replaced",
    async () => {
      const fx = await setupFixture();
      try {
        await mkdir(fx.cacheDir, { recursive: true });
        await symlink(path.join(fx.root, "does-not-exist"), fx.mirrorPath);

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).not.toBeNull();
        await expectHealthyMirror(fx);
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a mirror missing its objects directory is replaced",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await (await fx.cache.prepare(fx.remote, {}))?.release();
        await rm(path.join(fx.mirrorPath, "objects"), {
          recursive: true,
          force: true,
        });

        const prepared = await fx.cache.prepare(fx.remote, { logger });

        expect(prepared).not.toBeNull();
        await expectHealthyMirror(fx);
        expect(lines.filter((l) => RECREATING.test(l.message))).toHaveLength(1);
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a refresh that fails on corrupt objects recreates the mirror",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await (await fx.cache.prepare(fx.remote, {}))?.release();
        await corruptEveryObject(fx.mirrorPath);
        await fx.commit("after-corruption");
        await git(fx.seed, ["push", "origin", "main"]);

        const prepared = await fx.cache.prepare(fx.remote, { logger });

        expect(prepared).not.toBeNull();
        await expectHealthyMirror(fx);
        const recreating = lines.filter((l) => RECREATING.test(l.message));
        expect(recreating).toHaveLength(1);
        expect(recreating[0]?.message).toContain("corrupt");
        await prepared?.release();
        await onlyMirrorLeft(fx);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a refresh that fails on a ref pointing at a missing object recreates the mirror",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await (await fx.cache.prepare(fx.remote, {}))?.release();
        await writeFile(
          path.join(fx.mirrorPath, "refs", "heads", "main"),
          "0000000000000000000000000000000000000001\n",
        );

        const prepared = await fx.cache.prepare(fx.remote, { logger });

        expect(prepared).not.toBeNull();
        await expectHealthyMirror(fx);
        expect(lines.filter((l) => RECREATING.test(l.message))).toHaveLength(1);
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a garbage mirror inside a parent git repo is validated on its own, not via the parent",
    async () => {
      const fx = await setupFixture();
      try {
        await git(fx.root, ["init", "-b", "trunk"]);
        await plantGarbageDir(fx.mirrorPath);

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).not.toBeNull();
        await expectHealthyMirror(fx);
        expect(await git(fx.root, ["for-each-ref"])).toBe("");
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a corrupt mirror whose recreation fails returns null, cleans up and releases the lock",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await plantGarbageDir(fx.mirrorPath);
        await rm(fx.remote, { recursive: true, force: true });

        const prepared = await fx.cache.prepare(fx.remote, { logger });

        expect(prepared).toBeNull();
        expect(lines.filter((l) => RECREATING.test(l.message))).toHaveLength(1);
        const fallbacks = messages(lines).filter((m) =>
          m.startsWith("git-cache: falling back to plain clone ("),
        );
        expect(fallbacks).toHaveLength(1);
        expect(messages(lines).indexOf(fallbacks[0] ?? "")).toBeGreaterThan(
          lines.findIndex((l) => RECREATING.test(l.message)),
        );
        expect(await readdir(fx.cacheDir)).toEqual([]);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a prepare after a failed recreation heals once the remote is back",
    async () => {
      const fx = await setupFixture();
      try {
        await plantGarbageDir(fx.mirrorPath);
        const remoteBackup = path.join(fx.root, "remote-backup.git");
        await git(fx.root, ["clone", "--bare", fx.remote, remoteBackup]);
        await rm(fx.remote, { recursive: true, force: true });
        expect(await fx.cache.prepare(fx.remote, {})).toBeNull();

        await git(fx.root, ["clone", "--bare", remoteBackup, fx.remote]);
        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared).not.toBeNull();
        await expectHealthyMirror(fx);
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a network failure never deletes a good mirror and never logs a recreate",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await (await fx.cache.prepare(fx.remote, {}))?.release();
        const sentinel = path.join(fx.mirrorPath, "sentinel");
        await writeFile(sentinel, "still here");
        await rm(fx.remote, { recursive: true, force: true });

        const prepared = await fx.cache.prepare(fx.remote, { logger });

        expect(prepared).toBeNull();
        expect(await readFile(sentinel, "utf8")).toBe("still here");
        expect(await git(fx.mirrorPath, ["fsck", "--no-progress"])).toBe("");
        expect(lines.filter((l) => RECREATING.test(l.message))).toHaveLength(0);
        expect(lines).toHaveLength(1);
        expect(await readdir(fx.cacheDir)).toEqual([
          path.basename(fx.mirrorPath),
        ]);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a healthy mirror is refreshed in place without being recreated",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await (await fx.cache.prepare(fx.remote, {}))?.release();
        const sentinel = path.join(fx.mirrorPath, "sentinel");
        await writeFile(sentinel, "still here");
        await fx.commit("second");
        await git(fx.seed, ["push", "origin", "main"]);

        await (await fx.cache.prepare(fx.remote, { logger }))?.release();

        expect(await readFile(sentinel, "utf8")).toBe("still here");
        expect(lines).toHaveLength(0);
        await expectHealthyMirror(fx);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent("the lock is released after a successful heal", async () => {
    const fx = await setupFixture();
    try {
      await plantGarbageDir(fx.mirrorPath);

      const prepared = await fx.cache.prepare(fx.remote, {});
      expect(await readdir(fx.cacheDir)).toContain(path.basename(fx.lockPath));
      await prepared?.release();

      expect(await readdir(fx.cacheDir)).not.toContain(
        path.basename(fx.lockPath),
      );
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
