/**
 * Unit tests for the cached path of {@link CachedGitCloneService} against REAL
 * local git repos (no network access): the workspace clone must behave exactly
 * like the plain clone while being served from the mirror.
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCliCloneService } from "../../../../src/runtime/runtime-service/infra/git-cli-clone-service";
import {
  pathExists,
  setupCachedCloneFixture,
} from "./cached-git-clone-fixtures";
import { git } from "./git-test-fixtures";

describe("CachedGitCloneService (cache hit)", () => {
  test.concurrent(
    "clones from the mirror and points origin at the real remote",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        const result = await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });

        expect(result.resolvedBranch).toBe("main");
        expect(fx.fallback.calls).toHaveLength(0);
        expect(await pathExists(fx.mirrorPath)).toBe(true);
        expect(
          await git(fx.workspacePath, ["config", "--get", "remote.origin.url"]),
        ).toBe(fx.remote);
        const config = await readFile(
          path.join(fx.workspacePath, ".git", "config"),
          "utf8",
        );
        expect(config).not.toContain(fx.cacheDir);
        expect(config).not.toContain(fx.mirrorPath);
        expect(await git(fx.workspacePath, ["log", "--oneline"])).toContain(
          "init",
        );
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a commit pushed from the workspace lands in the real remote, not the mirror",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });
        await git(fx.workspacePath, ["config", "user.email", "ws@boboddy.dev"]);
        await git(fx.workspacePath, ["config", "user.name", "Workspace"]);
        await git(fx.workspacePath, [
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          "from workspace",
        ]);
        const sha = await git(fx.workspacePath, ["rev-parse", "HEAD"]);

        await git(fx.workspacePath, ["push", "origin", "HEAD:refs/heads/work"]);

        expect(await git(fx.remote, ["rev-parse", "refs/heads/work"])).toBe(
          sha,
        );
        expect(
          await git(fx.mirrorPath, ["for-each-ref", "refs/heads/work"]),
        ).toBe("");
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "the workspace shares objects with the mirror via hardlinks, never alternates",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });

        const sha = await git(fx.workspacePath, ["rev-parse", "HEAD"]);
        const looseObject = path.join(
          fx.workspacePath,
          ".git",
          "objects",
          sha.slice(0, 2),
          sha.slice(2),
        );
        expect((await stat(looseObject)).nlink).toBeGreaterThan(1);
        expect(
          await pathExists(
            path.join(
              fx.workspacePath,
              ".git",
              "objects",
              "info",
              "alternates",
            ),
          ),
        ).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent("the clone survives deletion of the mirror dir", async () => {
    const fx = await setupCachedCloneFixture();
    try {
      await fx.commit("second");
      await git(fx.seed, ["push", "origin", "main"]);
      await fx.service.cloneRepository({
        gitUrl: fx.remote,
        workspacePath: fx.workspacePath,
      });

      await rm(fx.cacheDir, { recursive: true, force: true });

      await git(fx.workspacePath, ["fsck", "--full", "--strict"]);
      expect(await git(fx.workspacePath, ["log", "--oneline"])).toContain(
        "second",
      );
      await git(fx.workspacePath, ["checkout", "--quiet", "HEAD~1"]);
      expect(await git(fx.workspacePath, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.concurrent(
    "the clone survives gc --prune=now on a mirror whose refs were dropped",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await fx.commit("second");
        await git(fx.seed, ["push", "origin", "main"]);
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });

        await git(fx.mirrorPath, ["update-ref", "-d", "refs/heads/main"]);
        await git(fx.mirrorPath, ["gc", "--prune=now", "--quiet"]);

        await git(fx.workspacePath, ["fsck", "--full", "--strict"]);
        await git(fx.workspacePath, ["checkout", "--quiet", "HEAD~1"]);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "resolvedBranch matches the remote default and the plain service",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await git(fx.seed, ["checkout", "-b", "develop"]);
        await fx.commit("on-develop");
        await git(fx.seed, ["push", "origin", "develop"]);
        await git(fx.remote, ["symbolic-ref", "HEAD", "refs/heads/develop"]);

        const cached = await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });
        const plain = await new GitCliCloneService().cloneRepository({
          gitUrl: fx.remote,
          workspacePath: path.join(fx.root, "plain-workspace"),
        });

        expect(cached.resolvedBranch).toBe("develop");
        expect(cached.resolvedBranch).toBe(plain.resolvedBranch);
        expect(fx.fallback.calls).toHaveLength(0);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "keeps full history and honours --no-tags like the plain clone",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await git(fx.seed, ["tag", "v1"]);
        await git(fx.seed, ["push", "origin", "v1"]);
        await fx.commit("second");
        await git(fx.seed, ["push", "origin", "main"]);

        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });
        await git(fx.workspacePath, ["fetch", "origin"]);

        expect(await git(fx.workspacePath, ["tag", "--list"])).toBe("");
        expect(
          await git(fx.workspacePath, [
            "config",
            "--get",
            "remote.origin.tagOpt",
          ]),
        ).toBe("--no-tags");
        expect(
          await git(fx.workspacePath, ["rev-list", "--count", "HEAD"]),
        ).toBe("2");
        expect(
          await git(fx.workspacePath, ["rev-parse", "--is-shallow-repository"]),
        ).toBe("false");
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "serves a fresh commit pushed to the remote since the last clone",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });
        const sha = await fx.commit("later");
        await git(fx.seed, ["push", "origin", "main"]);

        const second = path.join(fx.root, "workspace-2");
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: second,
        });

        expect(await git(second, ["rev-parse", "HEAD"])).toBe(sha);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "clones into an existing empty workspace dir, as the workspace manager provides",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await mkdir(fx.workspacePath, { recursive: true });

        const result = await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });

        expect(result.resolvedBranch).toBe("main");
        expect(fx.fallback.calls).toHaveLength(0);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "releases the mirror lock after a successful clone",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });

        expect(await pathExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );
});
