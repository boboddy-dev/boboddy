import type { startProcessClaimedExecution } from "./process-claimed-step-execution";
import {
  resolveProjectWorkLogger,
  resolveProjectWorkReporter,
} from "./process-project-work-logger";
import {
  DEFAULT_SESSION_START_MAX_POLLS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  type ProcessProjectWorkDeps,
  type ProcessProjectWorkInput,
  type StepExecutionRunTracker,
} from "../contracts/process-project-work-types";
import {
  buildFindingsSubmissionPath,
  tryPersistAgentFindings,
} from "./process-project-work-findings";
import {
  captureMissingFindingsDiagnostics,
  collectStepArtifacts,
  handleMissingFindings,
} from "./process-project-work-monitor-helpers";

// eslint-disable-next-line local/no-unknown-parameter-type
export function isExpectedStepOutputFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "without findings submission via boboddy-submit-step-findings",
    )
  );
}

async function markMonitorSucceeded(
  tracker: StepExecutionRunTracker,
  localRuntimeSessionId: string,
  agentSessionId: string,
): Promise<void> {
  await tracker.markSucceeded({
    id: localRuntimeSessionId,
    metadataJson: JSON.stringify({
      agentSessionId,
    }),
  });
}

async function markMonitorFailed(
  tracker: StepExecutionRunTracker,
  localRuntimeSessionId: string,
  failureReason: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tracker.markFailed({
    id: localRuntimeSessionId,
    failureReason,
    metadataJson: metadata ? JSON.stringify(metadata) : undefined,
  });
}

function buildMissingFindingsError(input: {
  agentBaseUrl: string;
  workspacePath: string;
  opencodeLogDirectory: string;
  agentSessionId: string;
}): Error {
  return new Error(
    [
      `Step execution completed without findings submission via boboddy-submit-step-findings after one retry for agent session ${input.agentSessionId}.`,
      `Expected findings file: ${buildFindingsSubmissionPath(input.workspacePath)}`,
      `OpenCode base URL: ${input.agentBaseUrl}`,
      `OpenCode logs on disk: ${input.opencodeLogDirectory}`,
    ].join(" "),
  );
}

export async function monitorStartedClaimedExecution(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  tracker: StepExecutionRunTracker,
  startedExecution: Awaited<ReturnType<typeof startProcessClaimedExecution>>,
  heartbeat: { stop(): Promise<void> },
  logStream: { flush(): Promise<void> },
) {
  // The live log stream is created, attached, and stopped by the caller so it
  // spans the full claim->monitor lifecycle. The monitor just logs through
  // deps.logger, which is already the streaming logger.
  const logger = resolveProjectWorkLogger(deps);
  const reporter = resolveProjectWorkReporter(deps);

  let hasSubmittedFindings = false;
  let hasCollectedArtifacts = false;
  let hasObservedSessionRunning = false;
  const missingFindingsState = {
    hasWaitedForSessionStop: false,
    hasRetriedFindingsSubmission: false,
    hasWaitedForRetriedFindingsSubmission: false,
  };
  let lastLoggedProviderErrorAttempt = -1;
  // Elapsed time (ms) and poll count spent waiting for the agent session to
  // first report running. Used to fail fast when the agent never starts (e.g.
  // an unreachable AI provider) instead of polling until the caller's overall
  // timeout. The poll-count cap keeps the guard effective even when
  // pollIntervalMs is 0 (elapsed time would never accrue).
  let sessionStartWaitMs = 0;
  let sessionStartWaitPolls = 0;
  const sessionStartTimeoutMs =
    input.sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS;
  const maxSessionStartWaitPolls =
    input.pollIntervalMs > 0
      ? Math.ceil(sessionStartTimeoutMs / input.pollIntervalMs)
      : DEFAULT_SESSION_START_MAX_POLLS;

  const cleanupRuntime = async () => {
    if (input.preserveRuntimeOnComplete) {
      logger.log("worker", "Preserving runtime environment after completion", {
        projectId: input.projectId,
        workerId: input.workerId,
        stepExecutionId: startedExecution.stepExecutionId,
        localRuntimeSessionId: startedExecution.localRuntimeSessionId,
      });
      return;
    }

    logger.log("worker", "Cleaning up runtime environment after completion", {
      projectId: input.projectId,
      workerId: input.workerId,
      stepExecutionId: startedExecution.stepExecutionId,
      localRuntimeSessionId: startedExecution.localRuntimeSessionId,
    });
    await startedExecution.environment.cleanup();
  };

  try {
    for (;;) {
      const healthSnapshot =
        await startedExecution.environment.checkContainerHealth?.();
      if (healthSnapshot) {
        logger.debug("health", "Container healthcheck", {
          projectId: input.projectId,
          workerId: input.workerId,
          stepExecutionId: startedExecution.stepExecutionId,
          localRuntimeSessionId: startedExecution.localRuntimeSessionId,
          runtimeContainerId: startedExecution.environment.runtimeContainerId,
          runtimeContainerStatus: healthSnapshot.runtimeContainerStatus,
        });
      }

      const stepExecution = await deps.workerClient.getStepExecution({
        stepExecutionId: startedExecution.stepExecutionId,
      });

      if (hasSubmittedFindings && stepExecution.status !== "running") {
        if (stepExecution.status === "succeeded") {
          await markMonitorSucceeded(
            tracker,
            startedExecution.localRuntimeSessionId,
            startedExecution.agentSessionId,
          );
          reporter.event({
            type: "step:succeeded",
            stepExecutionId: startedExecution.stepExecutionId,
          });
        } else {
          await markMonitorFailed(
            tracker,
            startedExecution.localRuntimeSessionId,
            `Step execution completed with status ${stepExecution.status}.`,
            {
              agentSessionId: startedExecution.agentSessionId,
              finalStepStatus: stepExecution.status,
            },
          );
          reporter.event({
            type: "step:failed",
            stepExecutionId: startedExecution.stepExecutionId,
            reason: `Completed with status ${stepExecution.status}`,
          });
        }

        return;
      }

      const sessionStatus = await deps.agentRunner.getSessionStatus({
        agentBaseUrl: startedExecution.environment.agentBaseUrl,
        workspaceFolder: startedExecution.environment.workspaceFolder,
        sessionId: startedExecution.agentSessionId,
      });

      // Surface upstream AI-provider errors (e.g. OpenAI `server_error`) as a
      // distinct signal. Throttle to once per attempt so a long retry storm
      // does not flood the logs.
      if (
        sessionStatus.providerError &&
        sessionStatus.providerError.attempt !== lastLoggedProviderErrorAttempt
      ) {
        lastLoggedProviderErrorAttempt = sessionStatus.providerError.attempt;
        logger.log("worker", "AI provider error while running step", {
          projectId: input.projectId,
          workerId: input.workerId,
          stepExecutionId: startedExecution.stepExecutionId,
          localRuntimeSessionId: startedExecution.localRuntimeSessionId,
          agentSessionId: startedExecution.agentSessionId,
          attempt: sessionStatus.providerError.attempt,
          providerMessage: sessionStatus.providerError.message,
        });
      }

      if (sessionStatus.running) {
        hasObservedSessionRunning = true;
        await deps.sleep(input.pollIntervalMs);
        continue;
      }

      const submissionResult = hasSubmittedFindings
        ? "submitted"
        : await tryPersistAgentFindings(deps, startedExecution, {
            // Collect artifacts while the step is still "running" — before
            // completeStepExecution transitions it out of "running" and the
            // artifact API starts rejecting uploads. Latched so it runs once.
            onBeforeComplete: async () => {
              if (!hasCollectedArtifacts) {
                await collectStepArtifacts(deps, startedExecution, logger);
                hasCollectedArtifacts = true;
                // Ship the artifact log lines NOW, while the step is still
                // "running". completeStepExecution (next in tryPersistAgentFindings)
                // transitions it out of "running", after which appendStepExecutionLogs
                // rejects — and the caller's finally logStream.stop() runs too late.
                await logStream.flush();
              }
            },
          });

      // `promptAsync` is fire-and-forget: it queues the prompt and returns
      // before opencode begins streaming the model response. During that
      // startup window the session reports `idle` (or is absent from the status
      // map), which is indistinguishable from "finished" via status alone. If
      // we have never seen the session report `busy`/`retry` AND no findings
      // have been written yet, treat this as "not started yet" and keep polling
      // — otherwise the very first poll misfires the "stopped without findings
      // submission" path before the agent has even begun working. Findings are
      // still checked above so a run that completes between two polls (without
      // ever being observed as busy) is finalized rather than waited on forever.
      if (submissionResult === "missing" && !hasObservedSessionRunning) {
        // Fail fast if the session never starts within the configured window.
        // Without this cap a broken agent/provider connection (e.g. the
        // in-container agent cannot reach the AI host) would keep reporting
        // `running: false` and poll until the caller's overall timeout.
        if (
          sessionStartWaitMs >= sessionStartTimeoutMs ||
          sessionStartWaitPolls >= maxSessionStartWaitPolls
        ) {
          // Capture OpenCode's own serve log + workspace diagnostics so a
          // never-started session (unreachable AI, provider/model resolution
          // failure, etc.) is debuggable from the worker logs instead of just
          // surfacing an opaque timeout.
          const startupDiagnostics = await captureMissingFindingsDiagnostics({
            workspacePath: startedExecution.environment.workspacePath,
            opencodeLogDirectory:
              startedExecution.environment.opencodeLogDirectory,
          });
          logger.log(
            "worker",
            "Agent session never started; captured OpenCode startup diagnostics",
            {
              projectId: input.projectId,
              workerId: input.workerId,
              stepExecutionId: startedExecution.stepExecutionId,
              localRuntimeSessionId: startedExecution.localRuntimeSessionId,
              agentSessionId: startedExecution.agentSessionId,
              agentBaseUrl: startedExecution.environment.agentBaseUrl,
              opencodeLogs: startupDiagnostics.opencodeLogs,
              findingsFile: startupDiagnostics.findingsFile,
              currentExecutionFile: startupDiagnostics.currentExecutionFile,
            },
          );
          throw new Error(
            `Agent session ${startedExecution.agentSessionId} never started ` +
              `(no busy/retry status observed within ${String(
                sessionStartTimeoutMs,
              )}ms). Check agent/AI provider connectivity. ` +
              `OpenCode base URL: ${startedExecution.environment.agentBaseUrl}`,
          );
        }
        logger.log("worker", "Waiting for agent session to start", {
          projectId: input.projectId,
          workerId: input.workerId,
          stepExecutionId: startedExecution.stepExecutionId,
          localRuntimeSessionId: startedExecution.localRuntimeSessionId,
          agentSessionId: startedExecution.agentSessionId,
          waitedMs: sessionStartWaitMs,
          sessionStartTimeoutMs,
        });
        await deps.sleep(input.pollIntervalMs);
        sessionStartWaitMs += input.pollIntervalMs;
        sessionStartWaitPolls += 1;
        continue;
      }

      if (submissionResult === "submitted") {
        hasSubmittedFindings = true;

        // Artifacts are collected via the onBeforeComplete callback passed to
        // tryPersistAgentFindings above, so they are copied while the step is
        // still "running" (before completion) and the artifact API accepts the
        // uploads.
        logger.log("worker", "Agent findings submitted successfully", {
          projectId: input.projectId,
          workerId: input.workerId,
          stepExecutionId: startedExecution.stepExecutionId,
          localRuntimeSessionId: startedExecution.localRuntimeSessionId,
        });
      } else {
        const action = await handleMissingFindings(
          deps,
          startedExecution,
          logger,
          missingFindingsState,
          stepExecution.status,
          input.workerId,
        );
        if (action === "continue") {
          await deps.sleep(input.pollIntervalMs);
          continue;
        }
        throw buildMissingFindingsError({
          agentBaseUrl: startedExecution.environment.agentBaseUrl,
          workspacePath: startedExecution.environment.workspacePath,
          opencodeLogDirectory:
            startedExecution.environment.opencodeLogDirectory,
          agentSessionId: startedExecution.agentSessionId,
        });
      }
    }
  } catch (error) {
    if (isExpectedStepOutputFailure(error)) {
      logger.error(
        "worker",
        "Step execution finished without required Boboddy findings output",
        {
          projectId: input.projectId,
          workerId: input.workerId,
          stepExecutionId: startedExecution.stepExecutionId,
          localRuntimeSessionId: startedExecution.localRuntimeSessionId,
          agentSessionId: startedExecution.agentSessionId,
          agentBaseUrl: startedExecution.environment.agentBaseUrl,
          findingsPath: buildFindingsSubmissionPath(
            startedExecution.environment.workspacePath,
          ),
          opencodeLogDirectory:
            startedExecution.environment.opencodeLogDirectory,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      );
    } else {
      logger.error("worker", "Monitor failed for claimed step execution", {
        projectId: input.projectId,
        workerId: input.workerId,
        stepExecutionId: startedExecution.stepExecutionId,
        localRuntimeSessionId: startedExecution.localRuntimeSessionId,
        error,
      });
    }
    // Collect artifacts while the step is still "running": the server-side
    // failStepExecution happens LATER in the caller's finally (after
    // logStream.stop()), so uploads are still accepted here. Best-effort — a
    // collection error is logged/swallowed so it never replaces the original
    // error thrown below. Guard is idempotent against the success-path latch;
    // eslint can't see the `true` write in the async onBeforeComplete closure.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional idempotency guard; latch is written in an async closure TS flow analysis can't track
    if (!hasCollectedArtifacts) {
      try {
        await collectStepArtifacts(deps, startedExecution, logger);
        hasCollectedArtifacts = true;
      } catch (collectionError) {
        logger.error(
          "worker",
          "Failed to collect step artifacts on failure path",
          {
            stepExecutionId: startedExecution.stepExecutionId,
            error: collectionError,
          },
        );
      }
      // Ship the artifact log lines while the step is still "running". The
      // caller's finally logStream.stop() also flushes while running on the
      // failure path (failStepExecution runs after it), so this is
      // belt-and-suspenders for deterministic, symmetric behaviour. Non-throwing
      // per the shipper contract, so it can't mask the original error re-thrown below.
      await logStream.flush();
    }
    // failClaimedStepIfStillRunning is intentionally NOT called here. The
    // log shipper's final flush must complete before the step is marked
    // failed — otherwise the API rejects log appends once the status leaves
    // "running". The caller (scheduleClaimedStepExecutionJob) owns that
    // call, after awaiting logStream.stop().
    await markMonitorFailed(
      tracker,
      startedExecution.localRuntimeSessionId,
      error instanceof Error ? error.message : String(error),
      {
        agentSessionId: startedExecution.agentSessionId,
        finalStepStatus: "failed",
      },
    );
    reporter.event({
      type: "step:failed",
      stepExecutionId: startedExecution.stepExecutionId,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await heartbeat.stop();
    await cleanupRuntime();
  }
}
