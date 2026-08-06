import type { BaseReporter } from "./reporter-types";

/**
 * The tail of `boboddy pipelines design` — the command closing its own loop.
 *
 * A design session used to end in prose: a count of definition files and a
 * command to type. But the session already knows everything needed to run what
 * it just built — the project, the pipeline the assignment points at, and the
 * one work item the whole interview was about (see `design-preflight.ts`). So
 * it offers to run it, and the user never has to learn that
 * `--work-item-id` exists.
 *
 * Two things gate the offer, and both are honest about it rather than failing
 * halfway:
 *
 * - A devcontainer, because every step executes inside one. Missing, the run is
 *   impossible, so there is nothing to ask.
 * - A pipeline for the assignment to point at. Absent, the session never got as
 *   far as pushing, so there is nothing to run.
 *
 * When the run does happen, every failure routes back into the design command —
 * the edit loop is the repair loop, and the agent can read the failure with the
 * user and change the pipeline. Note where that is *said*: a failing step or a
 * devcontainer that will not build is absorbed by the worker's polling loop, so
 * the offer never gets a chance to react to it. See
 * {@link RUN_REPAIR_GUIDANCE}.
 *
 * All I/O is behind {@link DesignRunOfferPorts} so the branching is unit-testable
 * without a terminal, a network, or a Docker daemon.
 */

export interface DesignRunOfferPorts {
  /** Does this repository have a `.devcontainer/devcontainer.json`? */
  hasDevcontainer(): Promise<boolean>;
  /**
   * The pipeline definition the project's default assignment points at — what
   * the session just pushed. `undefined` when the project has no assignment,
   * which means nothing was pushed.
   */
  resolveAssignedPipeline(): Promise<string | undefined>;
  /**
   * Ask whether to run it now. `false` on decline OR cancel: by this point the
   * session's work is already saved server-side, so there is nothing to fail.
   */
  confirmRun(workItemTitle: string): Promise<boolean>;
  /**
   * Queue a pipeline execution for the target work item. Creating the work item
   * does not start a run, so without this the worker would find nothing to
   * claim. Throws with an actionable message on failure.
   */
  queueRun(pipelineDefinitionId: string): Promise<void>;
  /**
   * Run the host worker against the target work item, in this terminal. Owns the
   * terminal once called, and throws when the run fails.
   */
  runWorker(): Promise<void>;
}

/** The one work item this session was about, and where it lives. */
export type DesignRunTarget = {
  projectId: string;
  workItemId: string;
  workItemTitle: string;
};

export type DesignRunOfferInput = {
  /**
   * Did the designer TUI exit cleanly? A crashed or signal-killed session has
   * no result worth offering to run.
   */
  tuiExitedCleanly: boolean;
  target: DesignRunTarget;
  reporter: BaseReporter;
  ports: DesignRunOfferPorts;
};

/** Heading for the closing block, opened after the TUI hands back the tty. */
export const RUN_OFFER_TITLE = "Run it";

/** Shown just before the worker takes over the terminal. */
export const RUN_LAUNCH_MESSAGE = "Starting the worker…";

/** The single closing line, worded identically wherever the offer can end. */
export const REFINE_MESSAGE =
  "Run `boboddy pipelines design` again to refine your pipelines.";

export const DEVCONTAINER_MISSING_MESSAGE =
  "No devcontainer in this repository. Boboddy runs every step inside your " +
  "project's devcontainer, so a run needs a `.devcontainer/devcontainer.json` " +
  "first — ask for one in your next design session, or add one by hand.";

export const NO_PIPELINE_MESSAGE =
  "No pipeline is assigned to this project yet, so there is nothing to run. " +
  "Re-run the design session and let the agent finish — it pushes the pipeline " +
  "and its assignment together.";

/** Precedes the copyable command on the paths that end without running. */
export const RUN_LATER_PREFIX = "Run it later:";

/**
 * Why that command finds nothing on its own. Declining is not a deferred yes, so
 * nothing is queued — and a worker with nothing to claim just polls.
 */
export const NOTHING_QUEUED_MESSAGE =
  "Nothing is queued yet — start a run from the work item in the dashboard, " +
  "then that command will pick it up.";

/**
 * Where a failed run sends the user: back into the session that built it.
 *
 * Worded for both tenses, because it is shown in both — ahead of a run the offer
 * cannot follow, and attached to the failures it can catch.
 */
export const RUN_REPAIR_GUIDANCE =
  "A failed run — a step, or the devcontainer build — is something to take back " +
  "to the designer: run `boboddy pipelines design` again and tell the agent what " +
  "happened. The edit loop is the repair loop.";

/** The whole command, ready to paste, scoped to this one work item. */
export function formatRunCommand(target: DesignRunTarget): string {
  return `boboddy work ${target.projectId} --work-item-id ${target.workItemId}`;
}

/**
 * Offer to run the pipeline the session just built on the item it was about,
 * and run it when the user says yes.
 *
 * {@link RUN_REPAIR_GUIDANCE} is always reachable from a failure: stated ahead of
 * the run for the failures the worker absorbs, and thrown for the ones that stop
 * it outright — so those exit non-zero.
 */
export async function runDesignRunOffer(
  input: DesignRunOfferInput,
): Promise<{ ran: boolean }> {
  const { target, reporter, ports } = input;

  if (!input.tuiExitedCleanly) {
    // The command's exit-code passthrough already speaks for a broken session;
    // an offer on top of it would be noise.
    return { ran: false };
  }

  const command = formatRunCommand(target);
  reporter.start(RUN_OFFER_TITLE);

  // Cheapest check first: this one is a `stat`, the next one is a round trip.
  if (!(await ports.hasDevcontainer())) {
    reporter.warn(DEVCONTAINER_MISSING_MESSAGE);
    reportRunLater(reporter, command);
    return { ran: false };
  }

  const pipelineDefinitionId = await ports.resolveAssignedPipeline();
  if (pipelineDefinitionId === undefined) {
    reporter.warn(NO_PIPELINE_MESSAGE);
    reporter.finish(REFINE_MESSAGE);
    return { ran: false };
  }

  if (!(await ports.confirmRun(target.workItemTitle))) {
    reportRunLater(reporter, command);
    return { ran: false };
  }

  await queueRunWithProgress(reporter, ports, pipelineDefinitionId);

  // Said before the run, not after it: the worker absorbs step failures into its
  // own polling loop and never returns, so `runWorker` cannot reject on a failed
  // step or a devcontainer that will not build. Ahead of the run is the only
  // place the repair route is guaranteed to be on screen when one lands.
  reporter.info(RUN_REPAIR_GUIDANCE);

  // Close the block before the worker opens its own; a live spinner and a
  // second reporter cannot share a tty.
  reporter.finish(RUN_LAUNCH_MESSAGE);

  try {
    await ports.runWorker();
  } catch (error) {
    // Reached only for failures that stop the worker outright — a bad id, a
    // rejected claim. It reports those through its own reporter before it
    // throws, so restating the cause would print the same paragraph twice.
    throw new Error(RUN_REPAIR_GUIDANCE, { cause: error });
  }

  return { ran: true };
}

/**
 * Queue the execution the worker will claim. Its failure is the user's first
 * sight of the problem, so the cause travels with the guidance.
 */
async function queueRunWithProgress(
  reporter: BaseReporter,
  ports: DesignRunOfferPorts,
  pipelineDefinitionId: string,
): Promise<void> {
  const task = reporter.startTask("Queuing the run…");
  try {
    await ports.queueRun(pipelineDefinitionId);
  } catch (error) {
    task.fail("Could not queue the run");
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`${cause}\n\n${RUN_REPAIR_GUIDANCE}`, { cause: error });
  }
  task.succeed("Run queued");
}

/**
 * The two paths that end without running: the command on its own line so it can
 * be copied whole, then why it finds nothing yet. Queueing an execution for a
 * user who did not ask for one would be a deferred yes, not a decline.
 */
function reportRunLater(reporter: BaseReporter, command: string): void {
  reporter.info(`${RUN_LATER_PREFIX} ${command}`);
  reporter.info(NOTHING_QUEUED_MESSAGE);
  reporter.finish(REFINE_MESSAGE);
}
