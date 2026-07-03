import { scheduleClaimedStepExecutions } from "./schedule-claimed-step-executions";
import {
  resolveProjectWorkLogger,
  resolveProjectWorkReporter,
} from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  ProcessProjectWorkResult,
} from "../contracts/process-project-work-types";
import { validateProcessProjectWorkInput } from "./validate-process-project-work-input";

function createWorkTotals() {
  return {
    claimedCount: 0,
    processedCount: 0,
    skippedCount: 0,
  };
}

function getAvailableSlots(
  input: ProcessProjectWorkInput,
  activeJobCount: number,
) {
  return Math.max(0, input.concurrency - activeJobCount);
}

function getClaimBatchSize(
  input: ProcessProjectWorkInput,
  availableSlots: number,
) {
  return Math.min(input.batchSize, availableSlots);
}

async function claimAvailableStepExecutions(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  availableSlots: number,
) {
  return await deps.workerClient.claimStepExecutions({
    projectId: input.projectId,
    workerId: input.workerId,
    batchSize: getClaimBatchSize(input, availableSlots),
    leaseDurationSeconds: input.leaseDurationSeconds,
    workItemId: input.workItemId,
  });
}

async function pollForStepExecutionClaims(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  totals: ReturnType<typeof createWorkTotals>,
  activeJobs: Set<Promise<void>>,
) {
  const logger = resolveProjectWorkLogger(deps);
  const availableSlots = getAvailableSlots(input, activeJobs.size);

  logger.log("worker", "Polling for work", {
    projectId: input.projectId,
    workerId: input.workerId,
    activeJobs: activeJobs.size,
    availableSlots,
  });
  resolveProjectWorkReporter(deps).event({ type: "worker:polling" });

  if (availableSlots === 0) {
    logger.log("worker", "No capacity available for new claims", {
      projectId: input.projectId,
      workerId: input.workerId,
      activeJobs: activeJobs.size,
      concurrency: input.concurrency,
    });
    return [];
  }

  logger.log("worker", "Claiming step executions", {
    projectId: input.projectId,
    workerId: input.workerId,
    batchSize: getClaimBatchSize(input, availableSlots),
    leaseDurationSeconds: input.leaseDurationSeconds,
  });
  const claims = await claimAvailableStepExecutions(
    input,
    deps,
    availableSlots,
  );
  totals.claimedCount += claims.length;

  logger.log("worker", "Claim step executions response received", {
    projectId: input.projectId,
    workerId: input.workerId,
    claimedCount: claims.length,
    totalClaimedCount: totals.claimedCount,
    stepExecutionIds: claims.map((claim) => claim.stepExecution.id),
  });

  if (claims.length > 0) {
    resolveProjectWorkReporter(deps).event({
      type: "worker:claimed",
      count: claims.length,
    });
  }

  return claims;
}

function logWorkerStart(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Worker client ready", {
    projectId: input.projectId,
    userId: deps.workerClient.userId,
  });
  resolveProjectWorkReporter(deps).event({
    type: "worker:ready",
    workerId: input.workerId,
  });
  logger.log("worker", "Resolved worker configuration", {
    projectId: input.projectId,
    workerId: input.workerId,
    concurrency: input.concurrency,
    batchSize: input.batchSize,
    pollIntervalMs: input.pollIntervalMs,
    leaseDurationSeconds: input.leaseDurationSeconds,
    workItemId: input.workItemId,
    preserveRuntimeOnComplete: input.preserveRuntimeOnComplete ?? false,
    once: input.once ?? false,
  });
}

async function waitForActiveJobs(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  activeJobs: Set<Promise<void>>,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Waiting for active jobs to settle", {
    projectId: input.projectId,
    workerId: input.workerId,
    activeJobs: activeJobs.size,
  });
  await Promise.allSettled(activeJobs);
}

function buildResult(
  totals: ReturnType<typeof createWorkTotals>,
): ProcessProjectWorkResult {
  return {
    claimedCount: totals.claimedCount,
    processedCount: totals.processedCount,
    skippedCount: totals.skippedCount,
  };
}

function logWorkerComplete(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  totals: ReturnType<typeof createWorkTotals>,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Worker run complete", {
    projectId: input.projectId,
    workerId: input.workerId,
    claimedCount: totals.claimedCount,
    processedCount: totals.processedCount,
    skippedCount: totals.skippedCount,
  });
  resolveProjectWorkReporter(deps).event({
    type: "worker:complete",
    processed: totals.processedCount,
    skipped: totals.skippedCount,
  });
}

async function closeRunTracker(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  tracker: ReturnType<ProcessProjectWorkDeps["createRunTracker"]>,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Closing run tracker", {
    projectId: input.projectId,
    workerId: input.workerId,
  });
  await tracker.close();
  logger.log("worker", "Run tracker closed", {
    projectId: input.projectId,
    workerId: input.workerId,
  });
}

async function sleepBeforeNextPoll(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Sleeping before next poll", {
    projectId: input.projectId,
    workerId: input.workerId,
    pollIntervalMs: input.pollIntervalMs,
  });
  resolveProjectWorkReporter(deps).event({
    type: "worker:idle",
    pollIntervalMs: input.pollIntervalMs,
  });
  await deps.sleep(input.pollIntervalMs);
}

function shouldStopPolling(input: ProcessProjectWorkInput) {
  return input.once === true;
}

async function waitForAnyActiveJobToFinish(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  activeJobs: Set<Promise<void>>,
) {
  const logger = resolveProjectWorkLogger(deps);

  if (activeJobs.size === 0) {
    return;
  }

  logger.log(
    "worker",
    `Skipping polling for work because execution limit of ${String(input.concurrency)} has been reached. Waiting for execution to finish.`,
    {
      projectId: input.projectId,
      workerId: input.workerId,
      concurrency: input.concurrency,
      activeJobs: activeJobs.size,
    },
  );
  await Promise.race(
    [...activeJobs].map(async (job) => {
      await Promise.allSettled([job]);
    }),
  );
}

async function runPollingLoop(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  tracker: ReturnType<ProcessProjectWorkDeps["createRunTracker"]>,
  totals: ReturnType<typeof createWorkTotals>,
  activeJobs: Set<Promise<void>>,
) {
  const logger = resolveProjectWorkLogger(deps);

  for (;;) {
    if (getAvailableSlots(input, activeJobs.size) === 0) {
      await waitForAnyActiveJobToFinish(input, deps, activeJobs);
      continue;
    }

    const claims = await pollForStepExecutionClaims(
      input,
      deps,
      totals,
      activeJobs,
    );

    scheduleClaimedStepExecutions(
      input,
      deps,
      claims,
      tracker,
      totals,
      activeJobs,
    );

    if (shouldStopPolling(input)) {
      logger.log("worker", "Single-pass mode enabled; exiting poll loop", {
        projectId: input.projectId,
        workerId: input.workerId,
      });
      return;
    }

    await sleepBeforeNextPoll(input, deps);
  }
}

export async function processProjectWork(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
): Promise<ProcessProjectWorkResult> {
  validateProcessProjectWorkInput(input);

  const logger = resolveProjectWorkLogger(deps);
  resolveProjectWorkReporter(deps).event({
    type: "worker:starting",
    projectId: input.projectId,
    concurrency: input.concurrency,
  });
  logger.log("worker", "Creating run tracker", {
    projectId: input.projectId,
    workerId: input.workerId,
  });

  const tracker = deps.createRunTracker();
  const totals = createWorkTotals();
  const activeJobs = new Set<Promise<void>>();

  logWorkerStart(input, deps);

  try {
    await runPollingLoop(input, deps, tracker, totals, activeJobs);
    await waitForActiveJobs(input, deps, activeJobs);
    logWorkerComplete(input, deps, totals);
    return buildResult(totals);
  } finally {
    await closeRunTracker(input, deps, tracker);
  }
}

export type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  ProcessProjectWorkResult,
  ProjectWorkLogger,
  StepExecutionAgentRunner,
  StepExecutionRunTracker,
  StepExecutionRuntimeEnvironment,
  StepExecutionRuntimeEnvironmentOrchestrator,
  StepExecutionWorkerClaim,
  StepExecutionWorkerClient,
  StepExecutionWorkerContext,
} from "../contracts/process-project-work-types";
