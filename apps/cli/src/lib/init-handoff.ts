import type { BaseReporter } from "./reporter-types";

/**
 * The tail of `boboddy init`.
 *
 * `init` used to end by creating a pipeline from a server-side template. That
 * was a second, web-app-biased way to author pipelines whose output never
 * landed in the user's `.boboddy/pipeline-builder`. It is gone; `init` now
 * hands straight over to `boboddy pipelines design`, which orients itself by
 * reading the repository.
 *
 * The I/O sits behind {@link InitHandoffPorts} so the branching — accepted vs.
 * declined vs. non-interactive — is unit-testable.
 */

export interface InitHandoffPorts {
  /**
   * Ask whether to start the designer now. `false` on decline OR cancel: the
   * epilogue is past the point where anything can still fail.
   */
  confirmLaunch(): Promise<boolean>;
  /** Run `boboddy pipelines design` in-process. Owns the terminal once called. */
  launchDesign(): Promise<void>;
}

/** The single next step, worded identically wherever `init` can end. */
export const DESIGN_NEXT_STEP_MESSAGE =
  "Next: run `boboddy pipelines design` to build your first pipeline.";

/** Shown just before the designer takes over the terminal. */
export const DESIGN_LAUNCH_MESSAGE = "Starting the pipeline designer…";

/**
 * Close out `init` by pointing at — and optionally launching — the designer.
 *
 * The reporter block is always closed before `launchDesign` runs: the design
 * command opens its own block and then hands the tty to a full-screen TUI,
 * which cannot share the terminal with a live clack spinner.
 */
export async function runInitHandoff(input: {
  interactive: boolean;
  reporter: BaseReporter;
  ports: InitHandoffPorts;
}): Promise<{ launched: boolean }> {
  const { interactive, reporter, ports } = input;

  if (!interactive) {
    reporter.info(DESIGN_NEXT_STEP_MESSAGE);
    reporter.finish("Project initialized");
    return { launched: false };
  }

  const accepted = await ports.confirmLaunch();
  if (!accepted) {
    reporter.info(DESIGN_NEXT_STEP_MESSAGE);
    reporter.finish("Project initialized");
    return { launched: false };
  }

  reporter.finish(DESIGN_LAUNCH_MESSAGE);
  await ports.launchDesign();
  return { launched: true };
}
