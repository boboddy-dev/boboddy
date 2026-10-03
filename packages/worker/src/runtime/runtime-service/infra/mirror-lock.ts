import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

export const DEFAULT_LOCK_POLL_INTERVAL_MS = 200;
export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_LOCK_STALE_MS = 5 * 60_000;

const OWNER_FILE = "owner.json";

/** How long a steal claim may live before it is presumed orphaned by a crash. */
const STEAL_CLAIM_STALE_MS = 30_000;

export type MirrorLockOptions = {
  isPidAlive?: ((pid: number) => boolean) | undefined;
  now?: (() => number) | undefined;
  pollIntervalMs?: number | undefined;
  waitTimeoutMs?: number | undefined;
  staleMs?: number | undefined;
};

export type MirrorLock = {
  release(): Promise<void>;
};

export class MirrorLockTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`timed out after ${String(waitedMs)}ms waiting for the mirror lock`);
    this.name = "MirrorLockTimeoutError";
  }
}

type ResolvedOptions = Required<MirrorLockOptions>;

type LockOwner = {
  pid: number;
  createdAt: number;
  token?: string | undefined;
};

type LockSnapshot = { owner: LockOwner | null; mtimeMs: number };

/**
 * Exclusive advisory lock implemented as an atomically created directory.
 *
 * The holder writes `owner.json` (`{pid, createdAt, token}`) into the lock dir.
 * Waiters poll until the dir disappears. A lock is stale, and stolen, when its
 * owner pid is no longer running or it is older than `staleMs`. A dir without a
 * readable `owner.json` is judged by its mtime, since there is a window between
 * `mkdir` and the owner write.
 *
 * Staleness never looks at whether the pid is our own: in-process contenders
 * see a live owner and wait for `release()` like any other waiter.
 *
 * Stealing is serialised by a short-lived claim dir (`<lock>.steal`, also a
 * `mkdir`). The claim holder re-inspects the lock, so it acts on the current
 * owner rather than a stale snapshot, then renames the dir away and deletes
 * it. That keeps two waiters that both saw the same stale lock from each
 * grabbing a turn: the loser could otherwise delete the lock the winner had
 * just created. A claim orphaned by a crash expires after
 * {@link STEAL_CLAIM_STALE_MS}.
 *
 * Throws {@link MirrorLockTimeoutError} when the wait budget runs out.
 */
export async function acquireMirrorLock(
  lockPath: string,
  options: MirrorLockOptions,
  log: (message: string) => void,
): Promise<MirrorLock> {
  const config = resolveOptions(options);
  const startedAt = performance.now();
  let announcedWait = false;

  for (;;) {
    const owner = await tryCreateLock(lockPath, config);
    if (owner !== null) {
      return createHandle(lockPath, owner);
    }

    const snapshot = await inspectLock(lockPath);
    if (snapshot === null) {
      continue;
    }

    if (describeStaleness(snapshot, config) !== null) {
      if (await stealStaleLock(lockPath, config, log)) {
        continue;
      }
    }

    if (performance.now() - startedAt >= config.waitTimeoutMs) {
      throw new MirrorLockTimeoutError(config.waitTimeoutMs);
    }
    if (!announcedWait) {
      announcedWait = true;
      const holder = snapshot.owner
        ? ` held by pid ${String(snapshot.owner.pid)}`
        : "";
      log(`git-cache: waiting for mirror lock${holder}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

async function stealStaleLock(
  lockPath: string,
  config: ResolvedOptions,
  log: (message: string) => void,
): Promise<boolean> {
  const claimPath = `${lockPath}.steal`;
  if (!(await tryClaim(claimPath, config))) {
    return false;
  }
  try {
    const snapshot = await inspectLock(lockPath);
    const reason = snapshot && describeStaleness(snapshot, config);
    if (!snapshot || !reason) {
      return false;
    }
    if (!(await removeIfOwnedBy(lockPath, snapshot.owner))) {
      return false;
    }
    log(`git-cache: stole stale lock (${reason})`);
    return true;
  } finally {
    await rm(claimPath, { recursive: true, force: true });
  }
}

async function tryClaim(
  claimPath: string,
  config: ResolvedOptions,
): Promise<boolean> {
  try {
    await mkdir(claimPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const claim = await stat(claimPath).catch(() => null);
  if (claim && config.now() - claim.mtimeMs > STEAL_CLAIM_STALE_MS) {
    await rm(claimPath, { recursive: true, force: true });
  }
  return false;
}

function resolveOptions(options: MirrorLockOptions): ResolvedOptions {
  return {
    isPidAlive: options.isPidAlive ?? isProcessAlive,
    now: options.now ?? Date.now,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
    waitTimeoutMs: options.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS,
    staleMs: options.staleMs ?? DEFAULT_LOCK_STALE_MS,
  };
}

/** `EPERM` means the process exists but belongs to someone else: still alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function tryCreateLock(
  lockPath: string,
  config: ResolvedOptions,
): Promise<LockOwner | null> {
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw error;
  }

  const owner: LockOwner = {
    pid: process.pid,
    createdAt: config.now(),
    token: randomUUID(),
  };
  try {
    await writeFile(`${lockPath}/${OWNER_FILE}`, JSON.stringify(owner));
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  return owner;
}

function createHandle(lockPath: string, owner: LockOwner): MirrorLock {
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      if (!sameOwner(await readOwner(lockPath), owner)) {
        return;
      }
      await removeIfOwnedBy(lockPath, owner);
    },
  };
}

async function inspectLock(lockPath: string): Promise<LockSnapshot | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return { owner: await readOwner(lockPath), mtimeMs };
}

function describeStaleness(
  snapshot: LockSnapshot,
  config: ResolvedOptions,
): string | null {
  const { owner, mtimeMs } = snapshot;
  const now = config.now();
  if (owner === null) {
    return now - mtimeMs > config.staleMs
      ? "lock dir has no owner and is older than the stale threshold"
      : null;
  }
  if (!config.isPidAlive(owner.pid)) {
    return `owner pid ${String(owner.pid)} is not running`;
  }
  if (now - owner.createdAt > config.staleMs) {
    return `owner pid ${String(owner.pid)} has held it longer than the stale threshold`;
  }
  return null;
}

/**
 * Removes the lock dir iff it still holds `expected`. The dir is renamed away
 * first so a concurrent `mkdir` of a new lock can never be deleted by mistake;
 * if the renamed dir turns out to belong to someone else, it is put back.
 */
async function removeIfOwnedBy(
  lockPath: string,
  expected: LockOwner | null,
): Promise<boolean> {
  const grave = `${lockPath}.removed-${String(process.pid)}-${randomUUID()}`;
  try {
    await rename(lockPath, grave);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (sameOwner(await readOwner(grave), expected)) {
    await rm(grave, { recursive: true, force: true });
    return true;
  }

  if (await exists(lockPath)) {
    await rm(grave, { recursive: true, force: true });
  } else {
    await rename(grave, lockPath).catch(() =>
      rm(grave, { recursive: true, force: true }),
    );
  }
  return false;
}

async function readOwner(dir: string): Promise<LockOwner | null> {
  let raw: string;
  try {
    raw = await readFile(`${dir}/${OWNER_FILE}`, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const { pid, createdAt, token } = parsed as Record<string, unknown>;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof createdAt !== "number"
    ) {
      return null;
    }
    return {
      pid,
      createdAt,
      token: typeof token === "string" ? token : undefined,
    };
  } catch {
    return null;
  }
}

function sameOwner(a: LockOwner | null, b: LockOwner | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.pid === b.pid && a.createdAt === b.createdAt && a.token === b.token;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
