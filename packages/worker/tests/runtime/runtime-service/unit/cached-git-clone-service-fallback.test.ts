/**
 * Unit tests for the fallback behaviour of {@link CachedGitCloneService}:
 * whenever the cache cannot serve the clone the plain service must receive the
 * original input and a workspace path in the same state as if the cache had
 * never been tried.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCommandError } from "../../../../src/runtime/runtime-service/infra/git-failure";
import {
  runGit,
  type GitRunner,
} from "../../../../src/runtime/runtime-service/infra/run-git";
import {
  createLogger,
  pathExists,
  setupCachedCloneFixture,
} from "./cached-git-clone-fixtures";
import { git } from "./git-test-fixtures";

const FALLBACK_LINE = "git-cache: falling back to plain clone (";

const skipSetUrl: GitRunner = (args, options) =>
  args.includes("set-url") ? Promise.resolve("") : runGit(args, options);

const failAfterLocalClone: GitRunner = async (args, options) => {
  const stdout = await runGit(args, options);
  if (args.includes("clone")) {
    throw new GitCommandError(
      "git clone failed: fatal: bad object deadbeef",
      "fatal: bad object deadbeef",
      128,
    );
  }
  return stdout;
};

describe("CachedGitCloneService (fallback)", () => {
  test.concurrent(
    "delegates to the plain service when prepare returns null",
    async () => {
      const fx = await setupCachedCloneFixture();
      const { lines, logger } = createLogger();
      try {
        await rm(fx.remote, { recursive: true, force: true });
        const input = {
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        };

        const result = await fx.service.cloneRepository(input);

        expect(result.resolvedBranch).toBe("fallback-branch");
        expect(fx.fallback.calls).toEqual([input]);
        expect(
          lines.some((line) => line.message.startsWith(FALLBACK_LINE)),
        ).toBe(true);
        expect(await pathExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "skips the cache and delegates for a URL carrying a password",
    async () => {
      const fx = await setupCachedCloneFixture();
      const { lines, logger } = createLogger();
      try {
        const input = {
          gitUrl: "https://user:s3cret-pass@example.invalid/org/repo.git",
          workspacePath: fx.workspacePath,
          logger,
        };

        const result = await fx.service.cloneRepository(input);

        expect(result.resolvedBranch).toBe("fallback-branch");
        expect(fx.fallback.calls).toEqual([input]);
        expect(await pathExists(fx.cacheDir)).toBe(false);
        expect(JSON.stringify(lines)).not.toContain("s3cret-pass");
        expect(
          lines.some((line) => line.message.startsWith(FALLBACK_LINE)),
        ).toBe(true);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a set-url readback mismatch falls back to the plain clone into a clean workspace path",
    async () => {
      const fx = await setupCachedCloneFixture({ runGit: skipSetUrl });
      const { lines, logger } = createLogger();
      try {
        const input = {
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        };

        const result = await fx.service.cloneRepository(input);

        expect(result.resolvedBranch).toBe("fallback-branch");
        expect(fx.fallback.calls).toEqual([input]);
        expect(fx.fallback.workspaceEntriesAtCall).toEqual([null]);
        const fallbackLine = lines.find((line) =>
          line.message.startsWith(FALLBACK_LINE),
        );
        expect(fallbackLine?.scope).toBe("git-cache");
        expect(fallbackLine?.message).toContain("origin");
        expect(await pathExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "after a mismatch the plain clone leaves origin on the real remote",
    async () => {
      const fx = await setupCachedCloneFixture({ runGit: skipSetUrl });
      try {
        const result = await fx.serviceWithPlainFallback.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });

        expect(result.resolvedBranch).toBe("main");
        expect(
          await git(fx.workspacePath, ["config", "--get", "remote.origin.url"]),
        ).toBe(fx.remote);
        expect(
          await readFile(path.join(fx.workspacePath, ".git", "config"), "utf8"),
        ).not.toContain(fx.cacheDir);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a corruption-looking local clone failure removes the partial clone, keeps the empty dir and falls back",
    async () => {
      const fx = await setupCachedCloneFixture({ runGit: failAfterLocalClone });
      const { lines, logger } = createLogger();
      try {
        await mkdir(fx.workspacePath, { recursive: true });

        const result = await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
          logger,
        });

        expect(result.resolvedBranch).toBe("fallback-branch");
        expect(fx.fallback.workspaceEntriesAtCall).toEqual([[]]);
        expect(
          lines.some(
            (line) =>
              line.message.startsWith(FALLBACK_LINE) &&
              line.message.includes("bad object"),
          ),
        ).toBe(true);
        expect(await pathExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a failed local clone into a missing workspace path leaves it missing for the fallback",
    async () => {
      const fx = await setupCachedCloneFixture({ runGit: failAfterLocalClone });
      try {
        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });

        expect(fx.fallback.workspaceEntriesAtCall).toEqual([null]);
        expect(await pathExists(fx.lockPath)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "a non-empty workspace is never touched: the plain service gets it as is",
    async () => {
      const fx = await setupCachedCloneFixture();
      try {
        await mkdir(fx.workspacePath, { recursive: true });
        await writeFile(
          path.join(fx.workspacePath, "keep.txt"),
          "keep",
          "utf8",
        );

        await fx.service.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: fx.workspacePath,
        });

        expect(fx.fallback.calls).toHaveLength(1);
        expect(fx.fallback.workspaceEntriesAtCall).toEqual([["keep.txt"]]);
        expect(await pathExists(fx.cacheDir)).toBe(false);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    },
  );
});
