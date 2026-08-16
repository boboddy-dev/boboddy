import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { AnalyticsEvents } from "@boboddy/observability/analytics/events";
import {
  readProjectConfig,
  resolveBoboddyBaseUrl,
  resolveSourceBranch,
  runProjectWork,
} from "@boboddy/worker";
import {
  createCliLogger,
  createTransport,
  ensureLogDir,
  resolveLogFilePath,
} from "../lib/logger";
import { createReporter } from "../lib/reporter";
import { createRecordingReporter } from "../lib/reporter-record";
import { runWorkDryRunCommand } from "../lib/dry-run-command";
import { readLocalEnvVars } from "../lib/local-env-vars";
import {
  captureMilestone,
  flushTelemetry,
  syncIdentityFromDisk,
} from "../lib/telemetry";

export interface WorkArguments {
  projectId: string | undefined;
  baseUrl: string | undefined;
  batchSize: number | undefined;
  concurrency: number | undefined;
  leaseDurationSeconds: number | undefined;
  once: boolean;
  preserveRuntimeOnComplete: boolean;
  pollIntervalMs: number | undefined;
  workerId: string | undefined;
  workItemId: string | undefined;
  /**
   * Override the branch checked out for the first step of this run (instead
   * of resolving and verifying the current local branch). Needed when
   * "current branch" isn't meaningful (CI) or isn't what's wanted (targeting
   * a colleague's branch). Unlike the auto-resolved current branch, an
   * override only needs to exist on `origin` — it need not be checked out
   * locally or match local HEAD.
   */
  sourceBranch: string | undefined;
  /**
   * Rehearse the environment a real step execution would launch — devcontainer
   * + in-container OpenCode, with the targeted step's real MCP servers
   * injected — then report container/OpenCode/MCP health instead of claiming
   * and running a real step. See `stepId` / `globalOnly`.
   */
  dryRun: boolean;
  /** Dry run only: fetch this step definition's real MCP servers to test. */
  stepId: string | undefined;
  /**
   * Dry run only: skip step-specific MCP injection and test whatever MCP
   * servers are already configured. Implied automatically when the project
   * has no step definitions yet.
   */
  globalOnly: boolean;
  /**
   * Dry run only: resolve this **pipeline** id to its ordered step list and
   * test its first step — unlike `stepId`, unambiguous by construction,
   * since a pipeline id can never be mistaken for one of its own steps' ids.
   * Wins outright over `stepId`/`globalOnly` when passed. This is what
   * `pipelines design`'s post-push run offer uses (#146) to validate what it
   * just pushed before queueing a run against it.
   */
  pipelineId: string | undefined;
}

/**
 * What a programmatic caller has to decide. Every field is optional because each
 * one has a flag default: {@link WorkArguments} is the yargs envelope, where
 * "absent" is spelled `undefined`, so writing all ten out at a call site would
 * say nothing beyond which few were actually chosen.
 */
export type WorkOptions = Partial<WorkArguments>;

/**
 * The command body, callable without yargs' argv envelope so
 * `boboddy pipelines design` can run the worker in-process when the user accepts
 * its closing offer (see `lib/design-run-offer.ts`) instead of re-spawning the
 * CLI. It owns the terminal for as long as it polls, and throws only on failures
 * that stop the worker outright — a failing step is absorbed by the polling loop.
 */
export async function runWork(arguments_: WorkOptions): Promise<void> {
  await ensureLogDir();
  const logFilePath = resolveLogFilePath();
  // Initialize the transport (and open the log file) before anything else logs.
  createTransport();

  const logger = createCliLogger("work-command");
  const recordReportPath = process.env["BOBODDY_RECORD_REPORT"];
  const reporter = recordReportPath
    ? createRecordingReporter(createReporter({ logFilePath }), recordReportPath)
    : createReporter({ logFilePath });
  const baseUrl = resolveBoboddyBaseUrl(arguments_.baseUrl);
  const projectId =
    arguments_.projectId ?? (await readProjectConfig())?.projectId;
  // The two flag defaults yargs would have supplied, applied here so a
  // programmatic caller only has to name what it actually chose.
  const once = arguments_.once ?? false;
  const preserveRuntimeOnComplete =
    arguments_.preserveRuntimeOnComplete ?? false;
  const dryRun = arguments_.dryRun ?? false;
  const globalOnly = arguments_.globalOnly ?? false;

  syncIdentityFromDisk(baseUrl);

  if (!projectId) {
    reporter.error(
      "No project ID provided. Pass one as an argument or run `boboddy init` first.",
    );
    logger.error(
      "No project ID provided. Pass one as an argument or run `boboddy init` first.",
    );
    await flushTelemetry();
    process.exit(1);
  }

  // Resolve (and verify) the branch to check out for the first step of this
  // run, before anything else — a dry run rehearses this exact same
  // resolution/verification, not just the real path. Fails fast rather than
  // silently falling back to the repo's default branch.
  let sourceBranch: string | null;
  try {
    const result = await resolveSourceBranch({
      cwd: process.cwd(),
      override: arguments_.sourceBranch,
    });
    sourceBranch = result.branch;
    if (result.warning) {
      reporter.warn(result.warning);
      logger.warn({ branch: sourceBranch }, result.warning);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error(message);
    logger.error({ err: error }, "Failed to resolve the source branch");
    await flushTelemetry();
    process.exit(1);
  }

  reporter.start(dryRun ? "Boboddy worker (dry run)" : "Boboddy worker");
  if (sourceBranch) {
    reporter.info(`Using source branch: ${sourceBranch}`);
  }

  logger.info(
    {
      projectId,
      baseUrl,
      batchSize: arguments_.batchSize,
      concurrency: arguments_.concurrency,
      leaseDurationSeconds: arguments_.leaseDurationSeconds,
      once,
      preserveRuntimeOnComplete,
      pollIntervalMs: arguments_.pollIntervalMs,
      workerId: arguments_.workerId,
      workItemId: arguments_.workItemId,
      dryRun,
      stepId: arguments_.stepId,
      globalOnly,
      pipelineId: arguments_.pipelineId,
      sourceBranch,
    },
    "Starting worker command",
  );

  const localEnvVars = await readLocalEnvVars();
  logger.info(
    {
      varCount: Object.keys(localEnvVars).length,
      varNames: Object.keys(localEnvVars),
    },
    "Loaded .boboddy/.env",
  );

  try {
    if (dryRun) {
      const { ok } = await runWorkDryRunCommand({
        projectId,
        baseUrl,
        stepId: arguments_.stepId,
        globalOnly,
        pipelineId: arguments_.pipelineId,
        // Reuses the same flag as the real path: "preserve the runtime
        // instead of tearing it down" means the same thing for a dry run.
        keep: preserveRuntimeOnComplete,
        localEnvVars,
        reporter,
        sourceBranch,
      });

      if (!ok) {
        throw new Error(
          "Dry run found unhealthy checks — see the report above.",
        );
      }

      reporter.finish("Dry run healthy");
      captureMilestone(AnalyticsEvents.CliDryRunPassed, { via: "work" });
      return;
    }

    const result = await runProjectWork({
      projectId,
      baseUrl,
      batchSize: arguments_.batchSize,
      concurrency: arguments_.concurrency,
      leaseDurationSeconds: arguments_.leaseDurationSeconds,
      preserveRuntimeOnComplete,
      once,
      pollIntervalMs: arguments_.pollIntervalMs,
      workerId: arguments_.workerId,
      workItemId: arguments_.workItemId,
      dest: createTransport(),
      localEnvVars,
      reporter,
      sourceBranch,
    });

    if (once) {
      logger.info(
        {
          projectId,
          ...result,
        },
        "Single-pass work result",
      );
    }

    reporter.finish("Done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error(message);
    reporter.finish(
      dryRun ? "Dry run found problems" : "Worker stopped with errors",
    );
    logger.error(
      { err: error },
      dryRun ? "Work dry run failed" : "Worker command failed",
    );
    throw error;
  }
}

export const workCommand: CommandModule<object, WorkArguments> = {
  command: "work [projectId]",
  describe: "Run the Boboddy host worker for a project",
  builder: (argv: Argv<object>) =>
    argv
      .positional("projectId", {
        describe:
          "The project id to process work for (defaults to the id in .boboddy/boboddy.jsonc)",
        type: "string",
      })
      .option("baseUrl", {
        alias: "base-url",
        describe: "Boboddy app base URL",
        type: "string",
      })
      .option("batchSize", {
        alias: "b",
        describe: "Maximum number of step executions to claim per poll",
        type: "number",
      })
      .option("concurrency", {
        alias: "c",
        describe: "Maximum number of concurrently active jobs",
        type: "number",
      })
      .option("leaseDurationSeconds", {
        alias: "l",
        describe: "How long the claim lease should last",
        type: "number",
      })
      .option("pollIntervalMs", {
        alias: "p",
        describe: "How often to poll for new step executions",
        type: "number",
      })
      .option("once", {
        describe: "Poll a single time and wait for any claimed jobs to finish",
        type: "boolean",
        default: false,
      })
      .option("preserveRuntimeOnComplete", {
        alias: "k",
        describe:
          "Keep runtime containers and workspace after step completion " +
          "(or, with --dry-run, after the health report)",
        type: "boolean",
        default: false,
      })
      .option("workerId", {
        alias: "w",
        describe: "Optional worker identifier to use while claiming steps",
        type: "string",
      })
      .option("workItemId", {
        alias: "work-item-id",
        describe: "Only process step executions for this work item ID",
        type: "string",
      })
      .option("sourceBranch", {
        alias: "source-branch",
        describe:
          "Override the branch checked out for the first step of this run " +
          "(defaults to your current local branch, which must exist and be " +
          "in sync with its origin remote)",
        type: "string",
      })
      .option("dryRun", {
        alias: "dry-run",
        describe:
          "Rehearse the environment a real step would launch (devcontainer + " +
          "OpenCode + MCP servers) and report its health instead of running work",
        type: "boolean",
        default: false,
      })
      .option("stepId", {
        alias: "step-id",
        describe:
          "Dry run only: fetch this step definition's real MCP servers to test",
        type: "string",
      })
      .option("globalOnly", {
        alias: "global-only",
        describe:
          "Dry run only: skip step-specific MCP injection and test whatever " +
          "is already configured",
        type: "boolean",
        default: false,
      })
      .option("pipelineId", {
        alias: "pipeline-id",
        describe:
          "Dry run only: resolve this pipeline definition ID to its first " +
          "step and test that (wins over --step-id/--global-only)",
        type: "string",
      }),
  handler: (arguments_: ArgumentsCamelCase<WorkArguments>) =>
    runWork(arguments_),
};
