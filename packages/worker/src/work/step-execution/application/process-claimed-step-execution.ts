import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "../../../common/contracts/uuid-v7";
import { failClaimedStepIfStillRunning } from "./fail-claimed-step-if-still-running";
import { resolveProjectWorkLogger } from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  StartedClaimedExecution,
  StepExecutionRunTracker,
  StepExecutionWorkerClaim,
  StepExecutionWorkerClient,
} from "../contracts/process-project-work-types";

function buildRunningMetadata(environment: {
  resolvedBranch: string;
  devcontainerConfigPath: string;
  aiImage: string;
  networkName: string;
}) {
  return JSON.stringify({
    resolvedBranch: environment.resolvedBranch,
    devcontainerConfigPath: environment.devcontainerConfigPath,
    aiImage: environment.aiImage,
    networkName: environment.networkName,
  });
}

async function createTrackedSession(
  tracker: StepExecutionRunTracker,
  input: {
    localRuntimeSessionId: UuidV7;
    projectId: UuidV7;
    stepExecutionId: UuidV7;
  },
) {
  await tracker.createSession({
    id: input.localRuntimeSessionId,
    projectId: input.projectId,
    stepExecutionId: input.stepExecutionId,
  });
}

async function markTrackedSessionRunning(
  tracker: StepExecutionRunTracker,
  input: {
    localRuntimeSessionId: UuidV7;
    workspacePath: string;
    devcontainerId: string;
    aiContainerId: string;
    aiBaseUrl: string;
    resolvedBranch: string;
    devcontainerConfigPath: string;
    aiImage: string;
    networkName: string;
  },
) {
  await tracker.markRunning({
    id: input.localRuntimeSessionId,
    workspacePath: input.workspacePath,
    devcontainerId: input.devcontainerId,
    aiContainerId: input.aiContainerId,
    aiBaseUrl: input.aiBaseUrl,
    metadataJson: buildRunningMetadata({
      resolvedBranch: input.resolvedBranch,
      devcontainerConfigPath: input.devcontainerConfigPath,
      aiImage: input.aiImage,
      networkName: input.networkName,
    }),
  });
}

async function markTrackedSessionFailed(
  tracker: StepExecutionRunTracker,
  input: {
    localRuntimeSessionId: UuidV7;
    failureReason: string;
    metadataJson?: string | undefined;
  },
) {
  await tracker.markFailed({
    id: input.localRuntimeSessionId,
    failureReason: input.failureReason,
    metadataJson: input.metadataJson,
  });
}

async function attachTrackedAgentSession(
  tracker: StepExecutionRunTracker,
  localRuntimeSessionId: UuidV7,
  agentSessionId: string,
) {
  await tracker.attachAgentSession({
    id: localRuntimeSessionId,
    agentSessionId,
  });
}

async function fetchWorkerContext(
  client: StepExecutionWorkerClient,
  claim: StepExecutionWorkerClaim,
) {
  return await client.getStepExecutionWorkerContext({
    stepExecutionId: claim.stepExecution.id,
    claimToken: claim.claimToken,
  });
}

function resolveRequestedBranch(
  requestedBranch: string | null | undefined,
): string | null {
  const explicitBranch = requestedBranch?.trim();
  if (explicitBranch) return explicitBranch;

  const envBranch = process.env["BOBODDY_WORK_REQUESTED_BRANCH"]?.trim();

  return envBranch || null;
}

async function launchRuntimeEnvironment(
  deps: ProcessProjectWorkDeps,
  input: {
    localRuntimeSessionId: UuidV7;
    workerContext: Awaited<ReturnType<typeof fetchWorkerContext>>;
    requestedByUserId: UuidV7;
  },
) {
  return await deps.runtimeEnvironmentOrchestrator.launch({
    sessionId: input.localRuntimeSessionId,
    projectId: parseUuidV7(input.workerContext.projectId),
    requestedByUserId: input.requestedByUserId,
    gitUrl: input.workerContext.gitUrl,
    requestedBranch: resolveRequestedBranch(
      input.workerContext.requestedBranch,
    ),
    opencodeMcpJson: input.workerContext.stepDefinition.opencodeMcpJson,
    agentPromptText: input.workerContext.agentPrompt.promptText,
    currentExecutionInfo: {
      stepExecutionId: input.workerContext.stepExecution.id,
      resultSchemaJson: input.workerContext.stepDefinition.resultSchemaJson,
    },
  });
}

export async function startProcessClaimedExecution(
  input: {
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    claim: StepExecutionWorkerClaim;
    leaseDurationSeconds: number;
  },
  deps: ProcessProjectWorkDeps,
  client: StepExecutionWorkerClient,
  tracker: StepExecutionRunTracker,
): Promise<StartedClaimedExecution> {
  const logger = resolveProjectWorkLogger(deps);
  const localRuntimeSessionId = createUuidV7();

  logger.log("step", "Starting claimed step execution", {
    projectId: input.projectId,
    requestedByUserId: input.requestedByUserId,
    stepExecutionId: input.claim.stepExecution.id,
    claimToken: input.claim.claimToken,
    localRuntimeSessionId,
    leaseDurationSeconds: input.leaseDurationSeconds,
  });
  let cleanup: (() => Promise<void>) | null = null;
  let stepExecutionId: UuidV7 = input.claim.stepExecution.id;

  await createTrackedSession(tracker, {
    localRuntimeSessionId,
    projectId: input.projectId,
    stepExecutionId: input.claim.stepExecution.id,
  });
  logger.log("step", "Created local runtime session record", {
    localRuntimeSessionId,
    stepExecutionId: input.claim.stepExecution.id,
  });

  try {
    logger.log("step", "Fetching worker context", {
      stepExecutionId: input.claim.stepExecution.id,
    });
    const workerContext = await fetchWorkerContext(client, input.claim);
    logger.log("step", "Fetched worker context", {
      stepExecutionId: input.claim.stepExecution.id,
      workerContextProjectId: workerContext.projectId,
      gitUrl: workerContext.gitUrl,
      requestedBranch: workerContext.requestedBranch ?? null,
      stepDefinitionKey: workerContext.stepDefinition.key,
      stepDefinitionName: workerContext.stepDefinition.name,
      sessionTitle: workerContext.agentPrompt.sessionTitle,
      promptLength: workerContext.agentPrompt.promptText.length,
    });

    logger.log("step", "Launching runtime environment", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
    });
    const environment = await launchRuntimeEnvironment(deps, {
      localRuntimeSessionId,
      workerContext,
      requestedByUserId: input.requestedByUserId,
    });
    cleanup = async () => {
      await environment.cleanup();
    };
    logger.log("step", "Runtime environment launched", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
      workspacePath: environment.workspacePath,
      resolvedBranch: environment.resolvedBranch,
      devcontainerConfigPath: environment.devcontainerConfigPath,
      devcontainerId: environment.devcontainerId,
      aiContainerId: environment.aiContainerId,
      aiBaseUrl: environment.aiBaseUrl,
      aiImage: environment.aiImage,
      networkName: environment.networkName,
    });

    await markTrackedSessionRunning(tracker, {
      localRuntimeSessionId,
      workspacePath: environment.workspacePath,
      devcontainerId: environment.devcontainerId,
      aiContainerId: environment.aiContainerId,
      aiBaseUrl: environment.aiBaseUrl,
      resolvedBranch: environment.resolvedBranch,
      devcontainerConfigPath: environment.devcontainerConfigPath,
      aiImage: environment.aiImage,
      networkName: environment.networkName,
    });
    logger.log("step", "Marked local runtime session as running", {
      localRuntimeSessionId,
      stepExecutionId: input.claim.stepExecution.id,
      workspacePath: environment.workspacePath,
      devcontainerId: environment.devcontainerId,
      aiContainerId: environment.aiContainerId,
    });

    const stepArtifactsDir = path.join(
      environment.workspacePath,
      ".boboddy",
      "step-artifacts",
    );
    await mkdir(stepArtifactsDir, { recursive: true });
    // The agent runs inside a container where the host workspacePath is mounted at /workspace.
    const containerStepArtifactsDir = "/workspace/.boboddy/step-artifacts";
    const resolvedPromptText = workerContext.agentPrompt.promptText
      .replaceAll("{{stepArtifactsDir}}/", `${containerStepArtifactsDir}/`)
      .replaceAll("{{stepArtifactsDir}}", `${containerStepArtifactsDir}/`);

    logger.log("step", "Starting agent run", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
      aiBaseUrl: environment.aiBaseUrl,
      sessionTitle: workerContext.agentPrompt.sessionTitle,
      stepArtifactsDir,
    });
    const agentRunResult = await deps.agentRunner.promptAsync({
      aiBaseUrl: environment.aiBaseUrl,
      sessionTitle: workerContext.agentPrompt.sessionTitle,
      promptText: resolvedPromptText,
      agent: "build",
    });
    logger.log("step", "Agent session started", {
      stepExecutionId: input.claim.stepExecution.id,
      agentSessionId: agentRunResult.sessionId,
    });

    await attachTrackedAgentSession(
      tracker,
      localRuntimeSessionId,
      agentRunResult.sessionId,
    );
    logger.log("step", "Attached agent session to local runtime session", {
      localRuntimeSessionId,
      agentSessionId: agentRunResult.sessionId,
    });
    stepExecutionId = input.claim.stepExecution.id;
    return {
      projectId: input.projectId,
      localRuntimeSessionId,
      stepExecutionId,
      claimToken: input.claim.claimToken,
      agentSessionId: agentRunResult.sessionId,
      environment,
    };
  } catch (error) {
    logger.error("step", "Claimed step execution failed", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
      error,
    });
    const finalStatus = await failClaimedStepIfStillRunning(client, logger, {
      stepExecutionId: input.claim.stepExecution.id,
      claimToken: input.claim.claimToken,
      error: error as
        | Error
        | { message?: string | undefined }
        | string
        | number
        | boolean
        | null
        | undefined,
    }).catch(() => "failed");

    await markTrackedSessionFailed(tracker, {
      localRuntimeSessionId,
      failureReason: error instanceof Error ? error.message : String(error),
      metadataJson: JSON.stringify({
        finalStepStatus: finalStatus,
      }),
    });
    logger.log("step", "Marked local runtime session failed after error", {
      localRuntimeSessionId,
      stepExecutionId: input.claim.stepExecution.id,
      finalStepStatus: finalStatus,
    });
    logger.log("step", "Cleaning up startup artifacts after failure", {
      stepExecutionId,
      localRuntimeSessionId,
      hasCleanup: cleanup !== null,
    });
    await cleanup?.();
    throw error;
  }
}
