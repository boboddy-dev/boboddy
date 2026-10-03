import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  GitCacheLogger,
  GitMirrorCache,
  MirrorOutcome,
  PreparedMirror,
  PrepareMirrorOptions,
} from "../application/git-mirror-cache";
import { isCacheableUrl, mirrorKey } from "../domain/git-mirror-key";
import {
  GIT_CACHE_LOG_SCOPE,
  logCacheFallback,
  redactGitUrl,
} from "./git-cache-log";
import {
  GitCommandError,
  isEnvironmentFailure,
  isRepoCorruption,
} from "./git-failure";
import { acquireMirrorLock, type MirrorLockOptions } from "./mirror-lock";
import { runGit } from "./run-git";

/**
 * Backstop for a stalled transfer, matching `GitCliCloneService`: abort if no
 * data arrives for this many seconds, on top of the hard wall-clock timeouts.
 */
const LOW_SPEED_TIME_SECONDS = 60;
const LOW_SPEED_LIMIT_BYTES_PER_SEC = 1000;

const REFRESH_TIMEOUT_MS = 2 * 60_000;
const CREATE_TIMEOUT_MS = 10 * 60_000;

const BRANCH_REFSPEC = "+refs/heads/*:refs/heads/*";
const SYMREF_LINE = /^ref:\s+(refs\/heads\/\S+)\s+HEAD$/;

export type GitCliMirrorCacheOptions = {
  cacheDir: string;
  refreshTimeoutMs?: number;
  createTimeoutMs?: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  lockPollIntervalMs?: number;
  lockWaitTimeoutMs?: number;
  lockStaleMs?: number;
};

type MirrorTarget = {
  gitUrl: string;
  mirrorPath: string;
  logger: GitCacheLogger | undefined;
};

type RefreshInput = MirrorTarget & { timeoutMs: number };

/**
 * Persistent bare mirrors under `<cacheDir>/<key>.git`, one per remote.
 *
 * A mirror stores no remote URL: every refresh passes the real URL explicitly
 * to `git fetch` and `git ls-remote`, so nothing credential-shaped is written
 * to disk. Only branches are tracked (`refs/heads/*`, pruned, no tags), and the
 * mirror's `HEAD` follows the remote's default branch.
 *
 * Creation and refresh share one code path: a new mirror is initialised into
 * `<key>.git.tmp-<pid>`, refreshed, and renamed into place only on success, so a
 * crash never leaves a half-built mirror that looks valid.
 *
 * `prepare` holds an exclusive per-mirror lock (`<key>.lock`, see
 * `acquireMirrorLock`) while it refreshes and returns with the lock still held;
 * the caller's `release()` drops it after its workspace clone.
 *
 * Self-heal, inside the lock: a mirror that `git rev-parse --git-dir` rejects,
 * or whose refresh fails with a repo-corruption error (see `isRepoCorruption`),
 * is renamed away, deleted and recreated, at most once per `prepare`. Network,
 * auth and remote errors never delete a mirror. Git is always pointed at the
 * mirror with an explicit `--git-dir`, so a damaged mirror inside another git
 * repo is never mistaken for that parent repo.
 *
 * Any failure, including a lock wait timeout, resolves `prepare` to `null` after
 * logging the reason (with userinfo redacted) and releasing the lock, so the
 * caller falls back to a plain clone.
 */
export class GitCliMirrorCache implements GitMirrorCache {
  private readonly cacheDir: string;
  private readonly refreshTimeoutMs: number;
  private readonly createTimeoutMs: number;
  private readonly lockOptions: MirrorLockOptions;

  constructor(options: GitCliMirrorCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
    this.createTimeoutMs = options.createTimeoutMs ?? CREATE_TIMEOUT_MS;
    this.lockOptions = {
      isPidAlive: options.isPidAlive,
      now: options.now,
      pollIntervalMs: options.lockPollIntervalMs,
      waitTimeoutMs: options.lockWaitTimeoutMs,
      staleMs: options.lockStaleMs,
    };
  }

  async prepare(
    gitUrl: string,
    options: PrepareMirrorOptions,
  ): Promise<PreparedMirror | null> {
    const logger = options.logger;
    const key = isCacheableUrl(gitUrl) ? mirrorKey(gitUrl) : null;
    if (key === null) {
      logCacheFallback(
        logger,
        "repository URL is not cacheable (unsupported form or embedded credentials)",
      );
      return null;
    }

    try {
      return await this.lockAndSync(gitUrl, key, logger);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logCacheFallback(logger, redactGitUrl(reason, gitUrl));
      return null;
    }
  }

  /**
   * Takes the per-mirror lock, then creates or refreshes the mirror. The lock
   * is handed to the caller via `release()` on success and released here on
   * any failure, so a rejected call never leaves it held.
   */
  private async lockAndSync(
    gitUrl: string,
    key: string,
    logger: GitCacheLogger | undefined,
  ): Promise<PreparedMirror> {
    const mirrorPath = path.join(this.cacheDir, `${key}.git`);
    await mkdir(this.cacheDir, { recursive: true });
    const lock = await acquireMirrorLock(
      path.join(this.cacheDir, `${key}.lock`),
      this.lockOptions,
      (message) => logger?.log(GIT_CACHE_LOG_SCOPE, message),
    );

    let outcome: MirrorOutcome;
    try {
      outcome = await this.sync({ gitUrl, mirrorPath, logger });
    } catch (error) {
      await lock.release().catch(() => undefined);
      throw error;
    }

    return { mirrorPath, outcome, release: () => lock.release() };
  }

  private async sync(input: MirrorTarget): Promise<MirrorOutcome> {
    const { gitUrl, mirrorPath } = input;
    const createInput = { ...input, timeoutMs: this.createTimeoutMs };
    const refreshInput = { ...input, timeoutMs: this.refreshTimeoutMs };

    if (!(await entryExists(mirrorPath))) {
      await this.create(createInput);
      return "miss";
    }

    const invalid = await diagnoseMirror(mirrorPath, this.refreshTimeoutMs);
    if (invalid !== null) {
      await this.recreate(createInput, invalid);
      return "miss";
    }

    try {
      await this.refresh(refreshInput);
      return "hit";
    } catch (error) {
      if (error instanceof GitCommandError && isRepoCorruption(error.stderr)) {
        await this.recreate(createInput, redactGitUrl(error.message, gitUrl));
        return "miss";
      }
      throw error;
    }
  }

  private async recreate(input: RefreshInput, reason: string): Promise<void> {
    input.logger?.log(
      GIT_CACHE_LOG_SCOPE,
      `git-cache: mirror corrupt (${reason}), recreating`,
    );
    await discardMirror(input.mirrorPath);
    await this.create(input);
  }

  private async create(input: RefreshInput): Promise<void> {
    const tmpPath = `${input.mirrorPath}.tmp-${String(process.pid)}`;
    await rm(tmpPath, { recursive: true, force: true });
    try {
      await runGit(["init", "--bare", "--quiet", tmpPath], {
        label: "init",
        timeoutMs: input.timeoutMs,
      });
      await this.refresh({ ...input, mirrorPath: tmpPath });
      await rename(tmpPath, input.mirrorPath);
    } catch (error) {
      await rm(tmpPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async refresh(input: RefreshInput): Promise<void> {
    const { gitUrl, mirrorPath, timeoutMs } = input;
    const inMirror = (args: string[]): string[] => [
      "--git-dir",
      mirrorPath,
      ...args,
    ];

    await runGit(
      inMirror([
        "-c",
        `http.lowSpeedLimit=${String(LOW_SPEED_LIMIT_BYTES_PER_SEC)}`,
        "-c",
        `http.lowSpeedTime=${String(LOW_SPEED_TIME_SECONDS)}`,
        "fetch",
        "--prune",
        "--no-tags",
        "--quiet",
        "--",
        gitUrl,
        BRANCH_REFSPEC,
      ]),
      { label: "fetch", timeoutMs },
    );

    const defaultBranchRef = await resolveRemoteDefaultBranch(
      gitUrl,
      mirrorPath,
      timeoutMs,
    );
    await runGit(inMirror(["symbolic-ref", "HEAD", defaultBranchRef]), {
      label: "symbolic-ref",
      timeoutMs,
    });

    try {
      await runGit(
        inMirror(["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"]),
        { label: "gc", timeoutMs },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      input.logger?.log(
        GIT_CACHE_LOG_SCOPE,
        `git-cache: gc --auto failed (${redactGitUrl(reason, gitUrl)})`,
      );
    }
  }
}

async function resolveRemoteDefaultBranch(
  gitUrl: string,
  mirrorPath: string,
  timeoutMs: number,
): Promise<string> {
  const stdout = await runGit(
    [
      "--git-dir",
      mirrorPath,
      "-c",
      `http.lowSpeedLimit=${String(LOW_SPEED_LIMIT_BYTES_PER_SEC)}`,
      "-c",
      `http.lowSpeedTime=${String(LOW_SPEED_TIME_SECONDS)}`,
      "ls-remote",
      "--symref",
      "--",
      gitUrl,
      "HEAD",
    ],
    { label: "ls-remote", timeoutMs },
  );
  for (const line of stdout.split("\n")) {
    const match = SYMREF_LINE.exec(line.split("\t").join(" ").trim());
    if (match?.[1]) {
      return match[1];
    }
  }
  throw new Error("could not resolve the remote default branch");
}

/**
 * Asks git whether `mirrorPath` itself is a repository. Returns the reason when
 * it is not, `null` when it is. Failures that point at the environment
 * (permissions, ownership) are rethrown rather than treated as corruption.
 */
async function diagnoseMirror(
  mirrorPath: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    await runGit(["--git-dir", mirrorPath, "rev-parse", "--git-dir"], {
      label: "rev-parse",
      timeoutMs,
    });
    return null;
  } catch (error) {
    if (
      error instanceof GitCommandError &&
      error.exitCode !== null &&
      !isEnvironmentFailure(error.stderr)
    ) {
      return error.message;
    }
    throw error;
  }
}

/**
 * Renames the mirror to a unique name before deleting it: the rename is atomic,
 * so a crash mid-delete never leaves a half-deleted dir at the mirror path.
 */
async function discardMirror(mirrorPath: string): Promise<void> {
  const grave = `${mirrorPath}.corrupt-${String(process.pid)}-${randomUUID()}`;
  try {
    await rename(mirrorPath, grave);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await rm(grave, { recursive: true, force: true }).catch(() => undefined);
}

async function entryExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}
