import { mkdir, readdir, rm } from "node:fs/promises";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../application/git-clone-service";
import type {
  GitMirrorCache,
  PreparedMirror,
} from "../application/git-mirror-cache";
import { startStopwatch } from "../../../lib/elapsed";
import {
  GIT_CACHE_LOG_SCOPE,
  logCacheFallback,
  logFallbackClone,
  logLocalClone,
  logMirrorPrepared,
  redactGitUrl,
} from "./git-cache-log";
import { resolveBranchName } from "./git-cli-clone-service";
import { runGit, type GitRunner } from "./run-git";

const LOCAL_CLONE_TIMEOUT_MS = 10 * 60_000;
const CONFIG_TIMEOUT_MS = 30_000;

export type CachedGitCloneServiceOptions = {
  cache: GitMirrorCache;
  /** The plain clone, used whenever the mirror cannot serve the request. */
  fallback: GitCloneService;
  /** Git command runner; injectable so tests can inject faults. */
  runGit?: GitRunner;
};

/**
 * Clones the workspace from a persistent local mirror instead of the network,
 * then makes it indistinguishable from a plain clone: `origin` is rewritten to
 * the real remote and read back to verify, so a push can never reach the mirror.
 *
 * The workspace clone is `git clone --local --no-tags <mirror> <workspace>`:
 * objects are hardlinked (copied across filesystems), never shared through
 * `--reference`/alternates, so pruning or deleting the mirror cannot break a
 * workspace. The mirror's `HEAD` follows the remote default branch, so the
 * clone checks out the same branch a plain clone would and `resolvedBranch` is
 * computed by the same code.
 *
 * Any cache problem (no mirror, clone or `origin` rewrite failure, an `origin`
 * readback mismatch, an unresolvable branch) is logged, the workspace path is
 * restored to the state it had on entry, and the request is delegated to the
 * fallback. The mirror lock is held only for the local clone and is always
 * released before the fallback runs. A workspace path that is not empty on
 * entry is never touched by the cache: it goes straight to the fallback.
 *
 * Mirror prepare (lock wait included), local clone and fallback clone are each
 * timed and logged at info level under the `git-cache` scope, so they ship in
 * the step log.
 */
export class CachedGitCloneService implements GitCloneService {
  private readonly cache: GitMirrorCache;
  private readonly fallback: GitCloneService;
  private readonly runGit: GitRunner;

  constructor(options: CachedGitCloneServiceOptions) {
    this.cache = options.cache;
    this.fallback = options.fallback;
    this.runGit = options.runGit ?? runGit;
  }

  async cloneRepository(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    const entryState = await inspectWorkspace(input.workspacePath);
    if (entryState === "occupied") {
      logCacheFallback(input.logger, "workspace path is not empty");
      return this.cloneWithFallback(input);
    }

    const elapsedPrepare = startStopwatch();
    const prepared = await this.cache.prepare(input.gitUrl, {
      logger: input.logger,
    });
    if (prepared === null) {
      return this.cloneWithFallback(input);
    }
    logMirrorPrepared(input.logger, prepared.outcome, elapsedPrepare());

    const cached = await this.cloneFromMirror(input, prepared, entryState);
    return cached ?? this.cloneWithFallback(input);
  }

  private async cloneWithFallback(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    const elapsed = startStopwatch();
    const result = await this.fallback.cloneRepository(input);
    logFallbackClone(input.logger, elapsed());
    return result;
  }

  private async cloneFromMirror(
    input: CloneRepositoryInput,
    prepared: PreparedMirror,
    entryState: WorkspaceEntryState,
  ): Promise<CloneRepositoryResult | null> {
    const elapsed = startStopwatch();
    try {
      await this.localClone(input, prepared.mirrorPath);
      await this.restoreOrigin(input);
      const resolvedBranch = await resolveBranchName(input.workspacePath);
      logLocalClone(input.logger, elapsed());
      return { resolvedBranch };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logCacheFallback(input.logger, redactGitUrl(reason, input.gitUrl));
      await resetWorkspace(input.workspacePath, entryState);
      return null;
    } finally {
      await releaseQuietly(prepared, input);
    }
  }

  private async localClone(
    input: CloneRepositoryInput,
    mirrorPath: string,
  ): Promise<void> {
    await this.runGit(
      ["clone", "--local", "--no-tags", "--", mirrorPath, input.workspacePath],
      { label: "local clone", timeoutMs: LOCAL_CLONE_TIMEOUT_MS },
    );
  }

  private async restoreOrigin(input: CloneRepositoryInput): Promise<void> {
    const inWorkspace = (args: string[]): string[] => [
      "-C",
      input.workspacePath,
      ...args,
    ];
    await this.runGit(
      inWorkspace(["remote", "set-url", "origin", input.gitUrl]),
      { label: "remote set-url", timeoutMs: CONFIG_TIMEOUT_MS },
    );
    const stored = await this.runGit(
      inWorkspace(["config", "--get", "remote.origin.url"]),
      { label: "config remote.origin.url", timeoutMs: CONFIG_TIMEOUT_MS },
    );
    if (stored.replace(/\r?\n$/, "") !== input.gitUrl) {
      throw new Error("origin URL readback did not match the real remote");
    }
  }
}

type WorkspaceEntryState = "missing" | "empty" | "occupied";

async function inspectWorkspace(
  workspacePath: string,
): Promise<WorkspaceEntryState> {
  try {
    const entries = await readdir(workspacePath);
    return entries.length === 0 ? "empty" : "occupied";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

/** Puts the workspace path back to the state it had before the cached clone. */
async function resetWorkspace(
  workspacePath: string,
  entryState: WorkspaceEntryState,
): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
  if (entryState === "empty") {
    await mkdir(workspacePath, { recursive: true });
  }
}

async function releaseQuietly(
  prepared: PreparedMirror,
  input: CloneRepositoryInput,
): Promise<void> {
  try {
    await prepared.release();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.logger?.log(
      GIT_CACHE_LOG_SCOPE,
      `git-cache: failed to release mirror lock (${redactGitUrl(reason, input.gitUrl)})`,
    );
  }
}
