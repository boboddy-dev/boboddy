import {
  AnalyticsEvents,
  type CliRunOfferSkippedReason,
} from "@boboddy/observability/analytics/events";
import type { BaseReporter } from "./reporter-types";
import { captureMilestone } from "./telemetry";

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
 * Three things gate the offer, and all of them are honest about it rather than
 * failing halfway:
 *
 * - A pipeline for the assignment to point at. Absent, the session never got as
 *   far as pushing, so there is nothing to run.
 * - A devcontainer, but only when the pipeline has a step that executes inside
 *   the project's own one (a `workspace` step without a managed runtime).
 *   Host-only and managed-runtime pipelines run without it. When it is needed
 *   and missing, the run is impossible, so there is nothing to ask.
 * - Every step's declared health checks passing in a dry run: one launch per
 *   distinct runtime, each step's checks run against the launch it shares,
 *   reported per step. This is the single source of truth for "is what was
 *   just pushed obviously broken", so it runs once, blocking, right before the
 *   confirm: queueing a run the agent that built it can no longer see fail
 *   would leave the user alone with the failure. It blocks on what would stop
 *   a real run (a `required` check, or an environment that will not come up)
 *   and shows `warn` failures without blocking. Unlike the other two gates,
 *   its failure is recoverable in this same repository on the NEXT
 *   `pipelines design` session — see
 *   {@link DesignRunOfferPorts.runPipelineHealthDryRun}.
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

/** One step's check (or launch problem) as the gate shows it. */
export type HealthGateFinding = {
  stepName: string;
  /** The check's name, or `environment` / `mcp <server>` for a launch-level problem. */
  checkName: string;
  severity: "required" | "warn";
  passed: boolean;
  message: string;
  /** Whether this finding alone stops the run offer. */
  blocking: boolean;
};

/** The one shape the health-check gate produces, real or faked in tests. */
export type DryRunGateResult = {
  /** False exactly when some finding is `blocking`. */
  ok: boolean;
  /** One line naming every blocking finding, for the next session's marker. */
  summary: string;
  findings: HealthGateFinding[];
};

export interface DesignRunOfferPorts {
  /**
   * The pipeline definition the project's default assignment points at — what
   * the session just pushed. `undefined` when the project has no assignment,
   * which means nothing was pushed.
   */
  resolveAssignedPipeline(): Promise<string | undefined>;
  /**
   * Does any step of `pipelineDefinitionId` execute inside the project's own
   * devcontainer — a `workspace` step with no managed runtime?
   */
  pipelineNeedsProjectDevcontainer(
    pipelineDefinitionId: string,
  ): Promise<boolean>;
  /** Does this repository have a `.devcontainer/devcontainer.json`? */
  hasDevcontainer(): Promise<boolean>;
  /**
   * Run every step's declared health checks for `pipelineDefinitionId`, one
   * launch per distinct runtime, and report each step's outcome. Steps with no
   * checks (code steps always) are skipped, and every launch is torn down.
   *
   * There is no self-healing in this same session: the TUI (and the agent
   * inside it) has already exited by the time this runs, so a failure here is
   * recorded for the NEXT `pipelines design` session's orientation to pick up
   * instead — see `design-run-offer-gate-marker.ts`.
   */
  runPipelineHealthDryRun(
    pipelineDefinitionId: string,
  ): Promise<DryRunGateResult>;
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
  /** The `owner/slug` ref `projectId` was resolved from; what commands show. */
  project: string;
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
  "No devcontainer in this repository. This pipeline has steps that run inside " +
  "your project's devcontainer, so a run needs a " +
  "`.devcontainer/devcontainer.json` first — ask for one in your next design " +
  "session, or add one by hand.";

export const NO_PIPELINE_MESSAGE =
  "No pipeline is assigned to this project yet, so there is nothing to run. " +
  "Re-run the design session and let the agent finish — it pushes the pipeline " +
  "and its assignment together.";

/** Heads the health-check gate's failure; the failing steps follow, one per line. */
export const HEALTH_DRY_RUN_FAILED_MESSAGE =
  "A required health check failed in a dry run of the pushed pipeline, so this " +
  "would be an obviously-broken run:";

export const HEALTH_DRY_RUN_FAILED_NEXT_STEPS =
  "Run `boboddy pipelines design` again — the next session's orientation will " +
  "surface this and help you fix it before you push again.";

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
  return `boboddy work ${target.project} --work-item-id ${target.workItemId}`;
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
    reportSkipped("tui_not_clean");
    return { ran: false };
  }

  const command = formatRunCommand(target);
  reporter.start(RUN_OFFER_TITLE);

  const pipelineDefinitionId = await ports.resolveAssignedPipeline();
  if (pipelineDefinitionId === undefined) {
    reporter.warn(NO_PIPELINE_MESSAGE);
    reporter.finish(REFINE_MESSAGE);
    reportSkipped("no_pipeline");
    return { ran: false };
  }

  if (
    (await ports.pipelineNeedsProjectDevcontainer(pipelineDefinitionId)) &&
    !(await ports.hasDevcontainer())
  ) {
    reporter.warn(DEVCONTAINER_MISSING_MESSAGE);
    reportRunLater(reporter, command);
    reportSkipped("no_devcontainer");
    return { ran: false };
  }

  const dryRun = await runHealthDryRunWithProgress(
    reporter,
    ports,
    pipelineDefinitionId,
  );
  if (!dryRun.ok) {
    reporter.warn(HEALTH_DRY_RUN_FAILED_MESSAGE);
  }
  reportHealthFindings(reporter, dryRun.findings);
  if (!dryRun.ok) {
    reporter.info(HEALTH_DRY_RUN_FAILED_NEXT_STEPS);
    reportRunLater(reporter, command);
    reportSkipped("dry_run_failed");
    return { ran: false };
  }

  if (!(await ports.confirmRun(target.workItemTitle))) {
    reportRunLater(reporter, command);
    reportSkipped("declined");
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
 * Run the health-check gate with visible progress — spinning up a
 * devcontainer and an in-container OpenCode process is not instant, and a
 * silent multi-second pause here would read as a hang.
 */
async function runHealthDryRunWithProgress(
  reporter: BaseReporter,
  ports: DesignRunOfferPorts,
  pipelineDefinitionId: string,
): Promise<DryRunGateResult> {
  const task = reporter.startActivity(
    "Running every step's health checks before offering to run it…",
  );
  let result: DryRunGateResult;
  try {
    result = await ports.runPipelineHealthDryRun(pipelineDefinitionId);
  } catch (error) {
    task.fail("Could not run the health-check dry run");
    throw error;
  }
  if (result.ok) {
    task.succeed("Health checks passed");
  } else {
    task.fail("Health-check dry run failed");
  }
  return result;
}

/** `<step> › <check> (<severity>): <message>` — the per-step line the gate shows. */
export function formatHealthFinding(finding: HealthGateFinding): string {
  return `${finding.stepName} › ${finding.checkName} (${finding.severity}): ${finding.message}`;
}

/**
 * Every check that did not pass, by step: blocking ones as errors, the rest
 * (`warn` checks, MCP handshakes) as warnings that leave the offer open.
 */
function reportHealthFindings(
  reporter: BaseReporter,
  findings: readonly HealthGateFinding[],
): void {
  for (const finding of findings) {
    if (finding.passed) continue;
    const line = formatHealthFinding(finding);
    if (finding.blocking) {
      reporter.error(line);
    } else {
      reporter.warn(line);
    }
  }
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
  const task = reporter.startActivity("Queuing the run…");
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

/** Why the offer ended without running, for the `cli_run_offer_skipped` funnel event. */
function reportSkipped(reason: CliRunOfferSkippedReason): void {
  captureMilestone(AnalyticsEvents.CliRunOfferSkipped, { reason });
}
