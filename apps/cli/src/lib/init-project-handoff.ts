import type { BaseReporter } from "./reporter-types";
import { CliError } from "./cli-error";

/**
 * `init`'s browser hand-off (#141), the fallback when the project could not be
 * created through the API (see `init-project-autocreate.ts`).
 *
 * It opens `/projects/new` — pre-filled with the detected repo — and polls for
 * a project matching the same remote until the user has created it there.
 * Pressing Enter checks immediately instead of waiting out the interval; the
 * poll gives up after {@link HANDOFF_TIMEOUT_MS}.
 *
 * The I/O and the clock sit behind {@link ProjectHandoffPorts} so the loop is
 * unit-testable without a real browser, terminal, timer, or network.
 */

/** Wakes the poll loop: after a delay, or early when the user presses Enter. */
export interface HandoffCheckTrigger {
  /** Resolves after `delayMs`, or as soon as the user presses Enter. */
  wait(delayMs: number): Promise<"timer" | "enter">;
  /** Stop listening for Enter. */
  close(): void;
}

export interface ProjectHandoffPorts {
  /** Best-effort; a failure here just downgrades to "open this URL yourself". */
  openBrowser(url: string): Promise<void>;
  /**
   * One check for a project matching this repo's remote. Persists and returns
   * it once it exists; `undefined` while it doesn't yet.
   */
  checkForProject(): Promise<{ projectId: string } | undefined>;
  /** Start listening for Enter. Closed once the loop ends, however it ends. */
  startCheckTrigger(): HandoffCheckTrigger;
  /** Milliseconds since the epoch. */
  now(): number;
}

export const HANDOFF_POLL_INTERVAL_MS = 3_000;
export const HANDOFF_TIMEOUT_MS = 15 * 60 * 1_000;

/** The spinner shown while the poll runs. */
export const HANDOFF_WAITING_MESSAGE =
  "Waiting for the project to be created in your browser… (press Enter to check now, Ctrl+C to stop)";

export function nonInteractiveHandoffMessage(url: string): string {
  return (
    "No project found for this repository, and this session has no " +
    `interactive terminal to hand off to a browser. Create one at ${url}, ` +
    "then run `boboddy init` again."
  );
}

export function handoffTimedOutMessage(url: string, timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  return (
    `Still no project found for this repository after ${String(minutes)} ` +
    `minutes. Finish creating it at ${url}, then run \`boboddy init\` again.`
  );
}

/**
 * Open the browser to `url` and poll until a project for this repo exists.
 * Throws — rather than waiting on a browser nobody can see — when there is no
 * interactive terminal, and once the timeout passes with no project.
 */
export async function runProjectHandoff(input: {
  interactive: boolean;
  reporter: BaseReporter;
  url: string;
  ports: ProjectHandoffPorts;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{ projectId: string }> {
  const { interactive, reporter, url, ports } = input;
  const pollIntervalMs = input.pollIntervalMs ?? HANDOFF_POLL_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? HANDOFF_TIMEOUT_MS;

  if (!interactive) {
    throw new CliError(
      "project_handoff_noninteractive",
      nonInteractiveHandoffMessage(url),
    );
  }

  reporter.info(`Opening ${url}`);
  try {
    await ports.openBrowser(url);
  } catch {
    reporter.warn(
      "Could not open a browser automatically. Open the URL above manually.",
    );
  }

  const deadline = ports.now() + timeoutMs;
  const task = reporter.startTask(HANDOFF_WAITING_MESSAGE);
  const trigger = ports.startCheckTrigger();
  try {
    for (;;) {
      const linked = await ports.checkForProject();
      if (linked) {
        task.succeed("Project created and linked");
        return linked;
      }
      const remainingMs = deadline - ports.now();
      if (remainingMs <= 0) {
        throw new CliError(
          "project_handoff_unresolved",
          handoffTimedOutMessage(url, timeoutMs),
        );
      }
      await trigger.wait(Math.min(pollIntervalMs, remainingMs));
    }
  } catch (error) {
    task.fail("No project found for this repository");
    throw error;
  } finally {
    trigger.close();
  }
}
