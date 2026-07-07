import { createCliLogger, createTransport, ensureLogDir, resolveLogFilePath, type Logger } from "./logger";
import { createCliReporter } from "./reporter";
import type { BaseReporter } from "./reporter-types";

/**
 * Everything a command needs to talk to the user and to the logs. Handed to the
 * callback passed to {@link withReporter}.
 *
 * Output contract (see below) is split across the two sinks in this context:
 *
 * - `reporter` — human-facing status. Renders to **stderr** (clack on a TTY,
 *   plain lines when piped). Always visible; there is no `--verbose` gate.
 * - `logger` — pino diagnostics. Always written to the log **file**; also
 *   pretty-printed to stderr, but only when `--verbose` is set.
 *
 * Machine-readable data is not part of this context: commands should write it
 * to `process.stdout` directly, keeping stdout clean for piping.
 */
export interface CommandContext {
  reporter: BaseReporter;
  logger: Logger;
  logFilePath: string;
}

/**
 * Centralizes the dual-sink (reporter + pino logger) setup and error handling
 * every command needs, so command handlers don't repeat the boilerplate that
 * `work.ts` does by hand.
 *
 * It wires the file sink and the `--verbose` stderr stream before anything
 * logs, builds a reporter (human → stderr) and a scoped logger (diagnostics →
 * file), then runs `fn`. On failure it surfaces the error message on stderr via
 * the reporter (so it is always visible, not just in the log file), records the
 * full error to the logger, and rethrows the original error so the top-level
 * `run()` in `index.ts` still maps it to exit code 1. It never calls
 * `process.exit`.
 */
export async function withReporter<T>(
  scope: string,
  fn: (ctx: CommandContext) => Promise<T> | T,
): Promise<T> {
  await ensureLogDir();
  const logFilePath = resolveLogFilePath();
  // Initialize the transport (and open the log file) before anything else logs.
  createTransport();

  const logger = createCliLogger(scope);
  const reporter = createCliReporter({ logFilePath });

  try {
    return await fn({ reporter, logger, logFilePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error(message);
    logger.error({ err: error }, `${scope} failed`);
    throw error;
  }
}
