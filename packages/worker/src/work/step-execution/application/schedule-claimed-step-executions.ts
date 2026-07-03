import { createStepExecutionHeartbeatController } from "./create-step-execution-heartbeat-controller";
import { monitorStartedClaimedExecution } from "./process-project-work-monitor";
import { startProcessClaimedExecution } from "./process-claimed-step-execution";
import {
  resolveProjectWorkLogger,
} from "./process-project-work-logger";
import { StepExecutionLogStream } from "./start-step-execution-log-streaming";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StepExecutionWorkerClaim,
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

export function scheduleClaimedStepExecutionJob(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  claim: StepExecutionWorkerClaim,
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
  const logStream = new StepExecutionLogStream({
    workerClient: deps.workerClient,
    logger: baseLogger,
    stepExecutionId: claim.stepExecution.id,
    claimToken: claim.claimToken,
  });
  const logger = logStream.logger;
  const streamingDeps: ProcessProjectWorkDeps = { ...deps, logger };

  logger.log("worker", "Scheduling claimed step execution", {
    projectId: input.projectId,
    workerId: input.workerId,
    stepExecutionId: claim.stepExecution.id,
    activeJobsBeforeSchedule: activeJobs.size,
  });

  const heartbeat = createStepExecutionHeartbeatController(
    deps.workerClient,
    streamingDeps,
    {
      stepExecutionId: claim.stepExecution.id,
      claimToken: claim.claimToken,
      leaseDurationSeconds: input.leaseDurationSeconds,
    },
  );

  const job = (async () => {
    try {
      const startedExecution = await startProcessClaimedExecution(
        {
          projectId: input.projectId,
          requestedByUserId: deps.workerClient.userId,
          claim,
          leaseDurationSeconds: input.leaseDurationSeconds,
        },
        streamingDeps,
        deps.workerClient,
        tracker,
        logStream,
      );

      await monitorStartedClaimedExecution(
        input,
        streamingDeps,
        tracker,
        startedExecution,
        heartbeat,
      );
    } catch (error: unknown) {
      await heartbeat.stop();
      throw error;
    } finally {
      await logStream.stop();
    }
  })();

  activeJobs.add(job);
  logger.log("worker", "Claimed step execution added to active jobs", {
    projectId: input.projectId,
    workerId: input.workerId,
    stepExecutionId: claim.stepExecution.id,
    activeJobs: activeJobs.size,
  });

  void (async () => {
    try {
      await job;
      trackCompletedJob(totals, activeJobs, job);
      logger.log("worker", "Claimed step execution finished successfully", {
        projectId: input.projectId,
        workerId: input.workerId,
        stepExecutionId: claim.stepExecution.id,
        processedCount: totals.processedCount,
        activeJobsRemaining: activeJobs.size,
      });
    } catch (error: unknown) {
      trackRejectedJob(totals, activeJobs, job);
      logger.error("worker", "Claimed step execution promise rejected", {
        projectId: input.projectId,
        workerId: input.workerId,
        stepExecutionId: claim.stepExecution.id,
        skippedCount: totals.skippedCount,
        activeJobsRemaining: activeJobs.size,
        error,
      });
    }
  })();
}

export function scheduleClaimedStepExecutions(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  claims: StepExecutionWorkerClaim[],
  tracker: ReturnType<ProcessProjectWorkDeps["createRunTracker"]>,
  totals: WorkTotals,
  activeJobs: Set<Promise<void>>,
): void {
  for (const claim of claims) {
    scheduleClaimedStepExecutionJob(
      input,
      deps,
      claim,
      tracker,
      totals,
      activeJobs,
    );
  }
}
