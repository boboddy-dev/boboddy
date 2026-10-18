import { createTaskHeartbeatController } from "./create-task-heartbeat-controller";
import { failClaimedTaskIfStillRunning } from "./fail-claimed-task-if-still-running";
import { monitorStartedClaimedTask } from "./process-project-work-monitor";
import { startProcessClaimedTask } from "./process-claimed-task";
import { resolveProjectWorkLogger } from "./process-project-work-logger";
import { TaskLogStreaming } from "./start-task-log-streaming";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  TaskWorkerClaim,
} from "../contracts/process-project-work-types";

type WorkTotals = {
  claimedCount: number;
  processedCount: number;
  skippedCount: number;
};

function trackCompletedJob(
  totals: WorkTotals,
  activeJobs: Set<Promise<void>>,
  job: Promise<void>,
) {
  totals.processedCount += 1;
  activeJobs.delete(job);
}

function trackRejectedJob(
  totals: WorkTotals,
  activeJobs: Set<Promise<void>>,
  job: Promise<void>,
) {
  totals.skippedCount += 1;
  activeJobs.delete(job);
}

export function scheduleClaimedTaskJob(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  claim: TaskWorkerClaim,
  tracker: ReturnType<ProcessProjectWorkDeps["createRunTracker"]>,
  totals: WorkTotals,
  activeJobs: Set<Promise<void>>,
) {
  const baseLogger = resolveProjectWorkLogger(deps);

  // Start live log streaming as early as the claim so the *entire* lifecycle
  // (runtime setup, clone, container build, OpenCode bootstrap, monitoring) is
  // mirrored to the platform — not just the monitoring phase. The returned
  // logger tees worker diagnostics into the feed while preserving CLI/file
  // output. The per-job deps below route all downstream logging through it.
  const logStream = new TaskLogStreaming({
    workerClient: deps.workerClient,
    logger: baseLogger,
    taskId: claim.task.id,
    claimToken: claim.claimToken,
    // Path A: seed the masker with the user's .boboddy/.env values so they are
    // redacted from the shipped feed. Provider token(s) (Path B) are registered
    // later, from the runtime launch result.
    secretValues: input.secretValues,
  });
  const logger = logStream.logger;
  const streamingDeps: ProcessProjectWorkDeps = { ...deps, logger };

  logger.log("worker", "Scheduling claimed task", {
    projectId: input.projectId,
    workerId: input.workerId,
    taskId: claim.task.id,
    activeJobsBeforeSchedule: activeJobs.size,
  });

  const heartbeat = createTaskHeartbeatController(
    deps.workerClient,
    streamingDeps,
    {
      taskId: claim.task.id,
      claimToken: claim.claimToken,
      leaseDurationSeconds: input.leaseDurationSeconds,
    },
  );

  const job = (async () => {
    // Capture any thrown error so the finally block can report the step as
    // failed *after* flushing buffered logs. Flushing first is critical:
    // appendTaskLogs rejects once the step leaves "running", so any
    // lines still in the shipper buffer at the moment failTask is
    // called would be permanently lost.
    let executionError: unknown = undefined;
    try {
      const startedTask = await startProcessClaimedTask(
        {
          projectId: input.projectId,
          requestedByUserId: deps.workerClient.userId,
          claim,
          leaseDurationSeconds: input.leaseDurationSeconds,
          sourceBranch: input.sourceBranch,
          workerEnv: input.workerEnv,
          preserveRuntimeOnFailure: input.preserveRuntimeOnComplete ?? false,
        },
        streamingDeps,
        deps.workerClient,
        tracker,
        logStream,
      );

      await monitorStartedClaimedTask(
        input,
        streamingDeps,
        tracker,
        startedTask,
        heartbeat,
        logStream,
      );
    } catch (error: unknown) {
      await heartbeat.stop();
      executionError = error;
      throw error;
    } finally {
      // Flush buffered log lines to the platform BEFORE marking the step as
      // failed. This guarantees the error output (postCreateCommand failure,
      // AWS errors, etc.) reaches the API while the step is still "running"
      // and assertClaimOwnership will accept the appends.
      await logStream.stop();
      if (executionError !== undefined) {
        try {
          await failClaimedTaskIfStillRunning(deps.workerClient, logger, {
            taskId: claim.task.id,
            claimToken: claim.claimToken,
            error: executionError,
          });
        } catch (failError: unknown) {
          // Best-effort: if the fail call itself errors (e.g. already failed
          // via the heartbeat expiry), don't mask the original execution error
          // — but log it explicitly. A silent swallow previously hid a
          // server-side rollback that left the step stuck "running" until its
          // lease lapsed (surfacing as "abandoned").
          logger.error("step", "Failed to report claimed step failure", {
            taskId: claim.task.id,
            errorMessage:
              failError instanceof Error
                ? failError.message
                : String(failError),
          });
        }
      }
    }
  })();

  activeJobs.add(job);
  logger.log("worker", "Claimed task added to active jobs", {
    projectId: input.projectId,
    workerId: input.workerId,
    taskId: claim.task.id,
    activeJobs: activeJobs.size,
  });

  void (async () => {
    try {
      await job;
      trackCompletedJob(totals, activeJobs, job);
      logger.log("worker", "Claimed task finished successfully", {
        projectId: input.projectId,
        workerId: input.workerId,
        taskId: claim.task.id,
        processedCount: totals.processedCount,
        activeJobsRemaining: activeJobs.size,
      });
    } catch (error: unknown) {
      trackRejectedJob(totals, activeJobs, job);
      logger.error("worker", "Claimed task promise rejected", {
        projectId: input.projectId,
        workerId: input.workerId,
        taskId: claim.task.id,
        skippedCount: totals.skippedCount,
        activeJobsRemaining: activeJobs.size,
        error,
      });
    }
  })();
}

export function scheduleClaimedTasks(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  claims: TaskWorkerClaim[],
  tracker: ReturnType<ProcessProjectWorkDeps["createRunTracker"]>,
  totals: WorkTotals,
  activeJobs: Set<Promise<void>>,
): void {
  for (const claim of claims) {
    scheduleClaimedTaskJob(input, deps, claim, tracker, totals, activeJobs);
  }
}
