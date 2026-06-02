import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { STEP_EXECUTION_AGENT } from "@boboddy/opencode-plugin";
import { ProjectOpencodeRuntimeActions } from "../../opencode-runtime/application/project-opencode-runtime-actions";
import { failClaimedStepIfStillRunning } from "./fail-claimed-step-if-still-running";
import type { startProcessClaimedExecution } from "./process-claimed-step-execution";
import { resolveProjectWorkLogger } from "./process-project-work-logger";
import {
  isExpectedStepOutputFailure,
  tryProcessRuntimeRequest,
} from "./process-project-work-runtime-request-handler";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StepExecutionRunTracker,
} from "../contracts/process-project-work-types";
import {
  buildFindingsSubmissionPath,
  tryPersistAgentFindings,
} from "./process-project-work-findings";

const FINDINGS_RETRY_PROMPT = [
  "You finished without submitting Boboddy findings.",
  "Use the `boboddy-submit-step-findings` tool now.",
  "Write findings to `.boboddy/step-findings-submission.json`.",
  "Pass only `findingsJson`.",
  "The tool will load `.boboddy/current-execution/execution.json` and validate your findings against the stored schema.",
  "Do not end the task without calling that tool.",
].join(" ");

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
  aiBaseUrl: string;
  workspacePath: string;
  opencodeLogDirectory: string;
  agentSessionId: string;
}): Error {
  return new Error(
    [
      `Step execution completed without findings submission via boboddy-submit-step-findings after one retry for agent session ${input.agentSessionId}.`,
      `Expected findings file: ${buildFindingsSubmissionPath(input.workspacePath)}`,
      `OpenCode base URL: ${input.aiBaseUrl}`,
      `OpenCode logs on disk: ${input.opencodeLogDirectory}`,
    ].join(" "),
  );
}

async function collectStepArtifacts(
  deps: ProcessProjectWorkDeps,
  startedExecution: Awaited<ReturnType<typeof startProcessClaimedExecution>>,
  logger: ReturnType<typeof resolveProjectWorkLogger>,
): Promise<void> {
  const stepArtifactsDir = path.join(
    startedExecution.environment.workspacePath,
    ".boboddy",
    "step-artifacts",
  );

  try {
    await access(stepArtifactsDir);
  } catch {
    return;
  }

  const entries = await readdir(stepArtifactsDir, { recursive: true });

  for (const entry of entries) {
    const relativeStorePath = entry;
    const sourcePath = path.join(stepArtifactsDir, relativeStorePath);
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
      continue;
    }

    logger.log("worker", "Saving step artifact", {
      stepExecutionId: startedExecution.stepExecutionId,
      relativeStorePath,
      sourcePath,
    });

    await deps.artifactStore.saveArtifact({
      stepExecutionId: startedExecution.stepExecutionId,
      sourcePath,
      relativeStorePath,
    });
  }
}

export async function monitorStartedClaimedExecution(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  tracker: StepExecutionRunTracker,
  startedExecution: Awaited<ReturnType<typeof startProcessClaimedExecution>>,
  heartbeat: { stop(): Promise<void> },
) {
  const logger = resolveProjectWorkLogger(deps);
  let hasRetriedFindingsSubmission = false;
  let hasWaitedForRetriedFindingsSubmission = false;
  let hasSubmittedFindings = false;
  let hasCollectedArtifacts = false;
  let hasWaitedForSessionStop = false;
  const runtimeActions =
    deps.runtimeCommandRunner && deps.runtimeServiceRunner && deps.timeProvider
      ? new ProjectOpencodeRuntimeActions({
          runtimeCommandRunner: deps.runtimeCommandRunner,
          runtimeServiceRunner: deps.runtimeServiceRunner,
          timeProvider: deps.timeProvider,
        })
      : null;

  const cleanupRuntime = async () => {
    runtimeActions?.cleanupRunningProcesses();

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
        logger.log("health", "Container healthcheck", {
          projectId: input.projectId,
          workerId: input.workerId,
          stepExecutionId: startedExecution.stepExecutionId,
          localRuntimeSessionId: startedExecution.localRuntimeSessionId,
          devcontainerId: startedExecution.environment.devcontainerId,
          devcontainerStatus: healthSnapshot.devcontainerStatus,
          aiContainerId: startedExecution.environment.aiContainerId,
          aiContainerStatus: healthSnapshot.aiContainerStatus,
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
        }

        return;
      }

      const sessionStatus = await deps.agentRunner.getSessionStatus({
        aiBaseUrl: startedExecution.environment.aiBaseUrl,
        sessionId: startedExecution.agentSessionId,
      });

      await tryProcessRuntimeRequest(deps, startedExecution, runtimeActions);

      if (sessionStatus.running) {
        await deps.sleep(input.pollIntervalMs);
        continue;
      }

      // Agent session has stopped. Collect artifacts before persisting findings.
      if (!hasCollectedArtifacts) {
        await collectStepArtifacts(deps, startedExecution, logger);
        hasCollectedArtifacts = true;
      }

      const submissionResult = hasSubmittedFindings
        ? "submitted"
        : await tryPersistAgentFindings(deps, startedExecution);
      if (submissionResult === "submitted") {
        hasSubmittedFindings = true;
        logger.log("worker", "Agent findings submitted successfully", {
          projectId: input.projectId,
          workerId: input.workerId,
          stepExecutionId: startedExecution.stepExecutionId,
          localRuntimeSessionId: startedExecution.localRuntimeSessionId,
        });
      } else if (submissionResult === "missing") {
        if (!hasWaitedForSessionStop) {
          hasWaitedForSessionStop = true;
          logger.log(
            "worker",
            "OpenCode session stopped without findings submission; waiting one poll for late file writes before retrying",
            {
              projectId: input.projectId,
              workerId: input.workerId,
              stepExecutionId: startedExecution.stepExecutionId,
              localRuntimeSessionId: startedExecution.localRuntimeSessionId,
              status: stepExecution.status,
              agentSessionId: startedExecution.agentSessionId,
            },
          );
          await deps.sleep(input.pollIntervalMs);
          continue;
        }

        if (!hasRetriedFindingsSubmission) {
          hasRetriedFindingsSubmission = true;
          hasWaitedForRetriedFindingsSubmission = false;
          logger.log(
            "worker",
            "OpenCode session stopped without findings submission; sending one retry prompt",
            {
              projectId: input.projectId,
              workerId: input.workerId,
              stepExecutionId: startedExecution.stepExecutionId,
              localRuntimeSessionId: startedExecution.localRuntimeSessionId,
              status: stepExecution.status,
              agentSessionId: startedExecution.agentSessionId,
            },
          );

          await deps.agentRunner.sendRetryPrompt({
            aiBaseUrl: startedExecution.environment.aiBaseUrl,
            sessionId: startedExecution.agentSessionId,
            promptText: FINDINGS_RETRY_PROMPT,
            agent: STEP_EXECUTION_AGENT,
          });
          await deps.sleep(input.pollIntervalMs);
          continue;
        }

        if (!hasWaitedForRetriedFindingsSubmission) {
          hasWaitedForRetriedFindingsSubmission = true;
          logger.log(
            "worker",
            "OpenCode retry prompt was accepted but findings are still missing; waiting one extra poll before failing",
            {
              projectId: input.projectId,
              workerId: input.workerId,
              stepExecutionId: startedExecution.stepExecutionId,
              localRuntimeSessionId: startedExecution.localRuntimeSessionId,
              status: stepExecution.status,
              agentSessionId: startedExecution.agentSessionId,
            },
          );

          await deps.sleep(input.pollIntervalMs);
          continue;
        }

        throw buildMissingFindingsError({
          aiBaseUrl: startedExecution.environment.aiBaseUrl,
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
          aiBaseUrl: startedExecution.environment.aiBaseUrl,
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
    const finalStatus = await failClaimedStepIfStillRunning(
      deps.workerClient,
      logger,
      {
        stepExecutionId: startedExecution.stepExecutionId,
        claimToken: startedExecution.claimToken,
        error: error as
          | Error
          | { message?: string | undefined }
          | string
          | number
          | boolean
          | null
          | undefined,
      },
    ).catch(() => "failed");
    await markMonitorFailed(
      tracker,
      startedExecution.localRuntimeSessionId,
      error instanceof Error ? error.message : String(error),
      {
        agentSessionId: startedExecution.agentSessionId,
        finalStepStatus: finalStatus,
      },
    );
    throw error;
  } finally {
    await heartbeat.stop();
    await cleanupRuntime();
  }
}
