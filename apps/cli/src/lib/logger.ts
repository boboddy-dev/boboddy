import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino, { type DestinationStream } from "pino";
import PinoPretty from "pino-pretty";
import {
  createLogger,
  setDefaultLogDestination,
  type Logger,
} from "@boboddy/worker";

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
}

export function createTransport(): DestinationStream | undefined {
  if (transportResolved) {
    return cachedTransport;
  }
  transportResolved = true;

  const logFilePath = resolveLogFilePath();
  // Open the file synchronously so the stream is ready before any log calls.
  // `flags: "a"` appends rather than truncates in case of rapid restarts.
  const fileStream = createWriteStream(logFilePath, { flags: "a" });

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
