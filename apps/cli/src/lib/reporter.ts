import { ClackReporter } from "./reporter-clack";
import { PlainReporter } from "./reporter-plain";
import {
  type BaseReporter,
  type CliReporter,
  type WorkEvent,
  type WorkReporter,
  type WorkTask,
  noopBaseReporter,
  noopReporter,
} from "./reporter-types";

export { noopReporter, noopBaseReporter };
export type { WorkReporter, WorkTask, WorkEvent, BaseReporter, CliReporter };

/**
 * Build the concrete reporter for the current environment. Returns a
 * `@clack/prompts` reporter on an interactive TTY, otherwise a plain stderr
 * reporter that is safe to pipe. Both implement the full {@link CliReporter}
 * surface (base methods + `event`), so callers can narrow it as needed.
 */
function buildReporter(
  options: { isTty?: boolean; logFilePath?: string } = {},
): CliReporter {
  const isTty = options.isTty ?? process.stdout.isTTY;
  return isTty
    ? new ClackReporter(options.logFilePath)
    : new PlainReporter(options.logFilePath);
}

/**
 * Build the appropriate reporter for the current environment. Returns a
 * `@clack/prompts` reporter on an interactive TTY, otherwise a plain
 * stderr reporter that is safe to pipe. Used by the `work` command, which
 * needs the worker's `event(WorkEvent)` method.
 */
export function createReporter(
  options: { isTty?: boolean; logFilePath?: string } = {},
): CliReporter {
  return buildReporter(options);
}

/**
 * Build the general-purpose reporter for non-`work` commands. Returns the same
 * concrete instances as {@link createReporter} but typed as {@link BaseReporter}
 * so command code can't accidentally call the worker-specific `event` method.
 */
export function createCliReporter(
  options: { isTty?: boolean; logFilePath?: string } = {},
): BaseReporter {
  return buildReporter(options);
}
