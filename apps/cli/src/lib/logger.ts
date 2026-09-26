import { createWriteStream, mkdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino, { type DestinationStream } from "pino";
import PinoPretty from "pino-pretty";
import {
  createLogger,
  setDefaultLogDestination,
  type Logger,
} from "@boboddy/observability/logging/host";

export type { Logger };

/**
 * Whether the user asked for verbose diagnostics. When set, full pino logs are
 * pretty-printed to stderr alongside the friendly reporter UI on stdout.
 */
export function isVerbose(): boolean {
  return (
    process.env["BOBODDY_VERBOSE"] === "1" ||
    process.argv.includes("--verbose") ||
    process.argv.includes("-v")
  );
}

/**
 * The directory where worker log files are written.
 */
export const LOG_DIR = path.join(os.homedir(), ".boboddy", "logs");

const LOG_FILE_PATTERN = /^worker-.*\.log$/;
const MAX_LOG_FILES = 20;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Build the pino destination for the CLI, memoized so that every logger — the
 * CLI's own and all of the worker's — writes to the *same* stream. Two
 * independent pretty transports pointed at the same fd can interleave
 * mid-line; sharing one stream avoids that.
 *
 * Routing strategy:
 *
 * - **File** (always): raw NDJSON appended to `~/.boboddy/logs/worker-<ts>.log`.
 *   Written regardless of TTY state or log level, so there is always a file to
 *   inspect after a failure.
 * - **Non-TTY** (piped / CI): tee to stdout (machine-parseable NDJSON) AND the
 *   file.
 * - **TTY**: pretty logs on **stderr** (fd 2) AND the file. Whether the stderr
 *   stream emits anything is governed by the log level (silent unless
 *   `--verbose`); the file stream is always at `trace` level.
 */
let cachedTransport: DestinationStream | undefined;
let transportResolved = false;
let cachedLogFilePath: string | undefined;

export function resolveLogFilePath(): string {
  if (cachedLogFilePath) return cachedLogFilePath;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  cachedLogFilePath = path.join(LOG_DIR, `worker-${ts}.log`);
  return cachedLogFilePath;
}

export async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  // Excludes this run's own file: the module-level `cliLogger` singleton
  // below (line ~215) opens it at *import* time, via `createTransport`, which
  // runs before any caller reaches this `await` — so by the time we get here
  // it already exists, empty, and would otherwise match the empty-file rule.
  await pruneLogDir({ excludePath: resolveLogFilePath() });
}

/**
 * Every invocation gets its own `worker-<ts>.log` (see {@link resolveLogFilePath}),
 * and nothing else in the CLI ever revisits or deletes an old one. Left alone
 * this directory grows without bound. Run opportunistically at the start of
 * every invocation so it only ever touches files left behind by *previous*
 * runs — `excludePath` protects the current run's own file, which may already
 * exist by this point (see {@link ensureLogDir}).
 *
 * A file survives only if it clears all three bars: non-empty, among the
 * `maxFiles` most recently modified, and younger than `maxAgeMs`. Empty files
 * are dropped unconditionally — a 0-byte log is never useful, and they make up
 * the bulk of the pile-up (fast commands that open the file but never log a
 * line; see {@link createTransport}'s exit-time cleanup for the other half of
 * that fix).
 *
 * Best-effort throughout: a missing directory or an unlink losing a race with
 * another process is swallowed rather than surfaced, since failing to tidy up
 * old logs should never break the command the user actually ran.
 */
export async function pruneLogDir({
  dir = LOG_DIR,
  now = Date.now(),
  maxFiles = MAX_LOG_FILES,
  maxAgeMs = MAX_LOG_AGE_MS,
  excludePath,
}: {
  dir?: string;
  now?: number;
  maxFiles?: number;
  maxAgeMs?: number;
  excludePath?: string;
} = {}): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const stats = await Promise.all(
    entries
      .filter((name) => LOG_FILE_PATTERN.test(name))
      .map(async (name) => {
        const filePath = path.join(dir, name);
        try {
          const info = await stat(filePath);
          return { filePath, mtimeMs: info.mtimeMs, size: info.size };
        } catch {
          return undefined;
        }
      }),
  );

  const files = stats
    .filter((file): file is NonNullable<(typeof stats)[number]> => file !== undefined)
    .filter((file) => file.filePath !== excludePath)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const toDelete = files.filter(
    (file, index) =>
      file.size === 0 || index >= maxFiles || now - file.mtimeMs > maxAgeMs,
  );

  await Promise.all(toDelete.map((file) => unlink(file.filePath).catch(() => {})));
}

/**
 * Every invocation opens its log file up front (see {@link createTransport}),
 * before it's known whether the command will log anything. Most commands are
 * quiet by default — no `--verbose`, nothing above `trace` worth writing — so
 * the file stays at 0 bytes for the run's whole lifetime. Rather than deferring
 * the stream open (pino's multistream needs a real destination synchronously
 * at construction time), drop the file at exit if it never grew past empty.
 * `pruneLogDir` is the backstop for whatever this misses (crashes, `SIGKILL`).
 */
function cleanUpIfEmptyOnExit(logFilePath: string): void {
  process.on("exit", () => {
    try {
      if (statSync(logFilePath).size === 0) {
        unlinkSync(logFilePath);
      }
    } catch {
      // Already gone, or something else is wrong with it — not worth
      // surfacing during process teardown.
    }
  });
}

export function createTransport(): DestinationStream | undefined {
  if (transportResolved) {
    return cachedTransport;
  }
  transportResolved = true;

  const logFilePath = resolveLogFilePath();
  // `cliLogger` below builds its transport at module-eval time, before any
  // caller has had a chance to `await ensureLogDir()`. Create the directory
  // synchronously here so the write stream never opens against a missing
  // parent dir (which would otherwise surface as an unhandled `error` event
  // on the stream, since nothing observes async open failures below).
  mkdirSync(LOG_DIR, { recursive: true });
  // Open the file synchronously so the stream is ready before any log calls.
  // `flags: "a"` appends rather than truncates in case of rapid restarts.
  const fileStream = createWriteStream(logFilePath, { flags: "a" });
  cleanUpIfEmptyOnExit(logFilePath);

  if (process.stdout.isTTY) {
    const prettyStream = PinoPretty({
      colorize: true,
      translateTime: "SYS:standard",
      destination: 2, // stderr — keep stdout clean for the reporter UI
      ignore: "pid,hostname",
    });

    // The per-stream `level` here acts as a floor for that individual stream.
    // The parent logger must be at `trace` (set via BOBODDY_LOG_LEVEL below) for
    // records to reach multistream at all — a `silent` parent drops everything
    // before the streams ever see it.
    //
    // TTY without --verbose: pretty stream silenced per-stream; file always gets
    // everything. TTY with --verbose: both streams receive all records.
    const prettyLevel = isVerbose() ? "trace" : "silent";
    cachedTransport = pino.multistream([
      { stream: prettyStream, level: prettyLevel },
      { stream: fileStream, level: "trace" },
    ]);
  } else {
    // Non-TTY: tee stdout (existing contract) + file.
    cachedTransport = pino.multistream([
      { stream: process.stdout, level: "trace" },
      { stream: fileStream, level: "trace" },
    ]);
  }

  // Share this destination with every worker logger built without an explicit
  // `dest`, including the lazy module-level singletons. This is what makes
  // `--verbose` output coherent instead of a mix of pretty + raw NDJSON.
  setDefaultLogDestination(cachedTransport);
  return cachedTransport;
}

/**
 * The effective log level for the CLI. By this point the bootstrap module has
 * already pinned `BOBODDY_LOG_LEVEL` for the interactive case, so we simply
 * honor it (falling back to `info`).
 */
export function resolveLogLevel(): string {
  return process.env["BOBODDY_LOG_LEVEL"] ?? "info";
}

export const cliLogger: Logger = createLogger(
  {
    name: "@boboddy/cli",
    level: resolveLogLevel(),
  },
  createTransport(),
);

export function createCliLogger(scope: string): Logger {
  return cliLogger.child({ scope });
}
