/**
 * Unit tests for {@link GitCliMirrorCache} create and refresh against REAL local
 * git repos (no network access). The "remote" is a bare repo addressed by its
 * absolute path, which `isCacheableUrl` accepts.
 */
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { git } from "./git-test-fixtures";
import { createLogger, setupFixture } from "./git-mirror-cache-fixtures";

describe("GitCliMirrorCache create and refresh", () => {
  test.concurrent(
    "first prepare creates <key>.git atomically with the remote's branches",
    async () => {
      const fx = await setupFixture();
      try {
        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(prepared?.mirrorPath).toBe(fx.mirrorPath);
        expect(await git(fx.mirrorPath, ["rev-parse", "refs/heads/main"])).toBe(
          await git(fx.seed, ["rev-parse", "HEAD"]),
        );
        expect(
          await git(fx.mirrorPath, ["rev-parse", "--is-bare-repository"]),
        ).toBe("true");
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
    "a new commit on the remote appears after a second prepare",
    async () => {
      const fx = await setupFixture();
      try {
        await (await fx.cache.prepare(fx.remote, {}))?.release();
        const sha = await fx.commit("second");
        await git(fx.seed, ["push", "origin", "main"]);

        const prepared = await fx.cache.prepare(fx.remote, {});

        expect(await git(fx.mirrorPath, ["rev-parse", "refs/heads/main"])).toBe(
          sha,
        );
        await prepared?.release();
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a new remote branch appears after a second prepare",
    async () => {
      const fx = await setupFixture();
      try {
        await (await fx.cache.prepare(fx.remote, {}))?.release();
        await git(fx.seed, ["checkout", "-b", "feature/x"]);
        const sha = await fx.commit("on-feature");
        await git(fx.seed, ["push", "origin", "feature/x"]);

        await (await fx.cache.prepare(fx.remote, {}))?.release();

        expect(
          await git(fx.mirrorPath, ["rev-parse", "refs/heads/feature/x"]),
        ).toBe(sha);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent("a branch deleted on the remote is pruned", async () => {
    const fx = await setupFixture();
    try {
      await git(fx.seed, ["push", "origin", "main:doomed"]);
      await (await fx.cache.prepare(fx.remote, {}))?.release();
      expect(
        await git(fx.mirrorPath, ["branch", "--list", "doomed"]),
      ).toContain("doomed");

      await git(fx.seed, ["push", "origin", "--delete", "doomed"]);
      await (await fx.cache.prepare(fx.remote, {}))?.release();

      expect(await git(fx.mirrorPath, ["branch", "--list", "doomed"])).toBe("");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.concurrent("a changed remote default branch updates HEAD", async () => {
    const fx = await setupFixture();
    try {
      await (await fx.cache.prepare(fx.remote, {}))?.release();
      expect(await git(fx.mirrorPath, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/main",
      );

      await git(fx.seed, ["push", "origin", "main:develop"]);
      await git(fx.remote, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
      await (await fx.cache.prepare(fx.remote, {}))?.release();

      expect(await git(fx.mirrorPath, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/develop",
      );
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.concurrent("tracks branches only, not tags", async () => {
    const fx = await setupFixture();
    try {
      await git(fx.seed, ["tag", "v1"]);
      await git(fx.seed, ["push", "origin", "v1"]);

      await (await fx.cache.prepare(fx.remote, {}))?.release();

      expect(await git(fx.mirrorPath, ["tag", "--list"])).toBe("");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.concurrent("the mirror config stores no remote or URL", async () => {
    const fx = await setupFixture();
    try {
      await (await fx.cache.prepare(fx.remote, {}))?.release();
      await (await fx.cache.prepare(fx.remote, {}))?.release();

      const config = await readFile(path.join(fx.mirrorPath, "config"), "utf8");

      expect(config).not.toContain("[remote");
      expect(config).not.toContain("url");
      expect(config).not.toContain(fx.remote);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.concurrent(
    "refresh failure returns null, logs the fallback and keeps the mirror",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await (await fx.cache.prepare(fx.remote, {}))?.release();
        await rm(fx.remote, { recursive: true, force: true });

        const prepared = await fx.cache.prepare(fx.remote, { logger });

        expect(prepared).toBeNull();
        expect(lines).toHaveLength(1);
        expect(lines[0]?.scope).toBe("git-cache");
        expect(lines[0]?.message).toStartWith(
          "git-cache: falling back to plain clone (",
        );
        expect(await git(fx.mirrorPath, ["rev-parse", "--git-dir"])).toBe(".");
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "initial create failure returns null and leaves no mirror or tmp dir",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        await rm(fx.remote, { recursive: true, force: true });

        const prepared = await fx.cache.prepare(fx.remote, { logger });

        expect(prepared).toBeNull();
        expect(lines).toHaveLength(1);
        expect(await readdir(fx.cacheDir)).toEqual([]);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "an empty remote with no resolvable default branch returns null",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        const empty = path.join(fx.root, "empty.git");
        await mkdir(empty, { recursive: true });
        await git(empty, ["init", "--bare", "-b", "main"]);

        const prepared = await fx.cache.prepare(empty, { logger });

        expect(prepared).toBeNull();
        expect(lines[0]?.message).toContain("default branch");
        expect(await readdir(fx.cacheDir)).toEqual([]);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a non-cacheable URL returns null without logging the credential",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        const url = "https://user:s3cret-token@example.com/org/repo.git";

        const prepared = await fx.cache.prepare(url, { logger });

        expect(prepared).toBeNull();
        expect(lines).toHaveLength(1);
        expect(lines[0]?.message).toStartWith(
          "git-cache: falling back to plain clone (",
        );
        expect(JSON.stringify(lines)).not.toContain("s3cret-token");
        expect(JSON.stringify(lines)).not.toContain("user:");
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent("a URL git cannot understand returns null", async () => {
    const fx = await setupFixture();
    const { lines, logger } = createLogger();
    try {
      const prepared = await fx.cache.prepare("relative/path.git", { logger });

      expect(prepared).toBeNull();
      expect(lines).toHaveLength(1);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.concurrent(
    "failure logs redact userinfo from the underlying git error",
    async () => {
      const fx = await setupFixture();
      const { lines, logger } = createLogger();
      try {
        const url = `ssh://deploy@127.0.0.1:1${path.join(fx.root, "nope.git")}`;

        const prepared = await fx.cache.prepare(url, { logger });

        expect(prepared).toBeNull();
        expect(lines).toHaveLength(1);
        expect(JSON.stringify(lines)).not.toContain("deploy@");
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent("release leaves the mirror intact", async () => {
    const fx = await setupFixture();
    try {
      const prepared = await fx.cache.prepare(fx.remote, {});

      expect(prepared).not.toBeNull();
      await prepared?.release();
      expect(await git(fx.mirrorPath, ["rev-parse", "--git-dir"])).toBe(".");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
