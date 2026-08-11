import type { BaseReporter } from "./reporter-types";

/**
 * `init`'s browser hand-off (#141).
 *
 * `init` used to silently `POST /projects` the moment no project matched the
 * detected git remote, so the web UI's GitHub-linking choice was never seen.
 * It now opens `/projects/new` — pre-filled with the detected repo — and
 * waits for the user to finish there.
 *
 * v1 is deliberately manual: no polling, no deep link. The user presses
 * Enter once they're done, and `completeHandoff` does a single re-check —
 * not a poll loop — for a project matching the same remote.
 *
 * The I/O sits behind {@link ProjectHandoffPorts} so the branching is
 * unit-testable without a real browser, terminal, or network.
 */

export interface ProjectHandoffPorts {
  /** Best-effort; a failure here just downgrades to "open this URL yourself". */
  openBrowser(url: string): Promise<void>;
  /** Blocks until the user presses Enter. */
  waitForKeypress(): Promise<void>;
  /** Re-checks the server for a project matching this repo's remote, and persists it. */
  completeHandoff(): Promise<{ projectId: string }>;
}

/** Printed once the user is expected to finish setup in the browser. */
export const HANDOFF_INSTRUCTIONS_MESSAGE =
  "Finish creating the project in the browser, then press Enter to continue.";

/** The prompt `waitForKeypress` renders while it blocks. */
export const HANDOFF_KEYPRESS_PROMPT = "Press Enter to continue… ";

export function nonInteractiveHandoffMessage(url: string): string {
  return (
    "No project found for this repository, and this session has no " +
    `interactive terminal to hand off to a browser. Create one at ${url}, ` +
    "then run `boboddy init` again."
  );
}

/**
 * Open the browser to `url`, wait for the user to confirm they're done, and
 * resolve the project id via `ports.completeHandoff`. Throws — rather than
 * blocking forever on stdin — when there is no interactive terminal to hand
 * off to.
 */
export async function runProjectHandoff(input: {
  interactive: boolean;
  reporter: BaseReporter;
  url: string;
  ports: ProjectHandoffPorts;
}): Promise<{ projectId: string }> {
  const { interactive, reporter, url, ports } = input;

  if (!interactive) {
    throw new Error(nonInteractiveHandoffMessage(url));
  }

  reporter.info("No project found for this repository yet.");
  reporter.info(`Opening ${url}`);
  try {
    await ports.openBrowser(url);
  } catch {
    reporter.warn(
      "Could not open a browser automatically. Open the URL above manually.",
    );
  }

  reporter.info(HANDOFF_INSTRUCTIONS_MESSAGE);
  await ports.waitForKeypress();

  return ports.completeHandoff();
}
