import { mkdir } from "node:fs/promises";
import path from "node:path";
import { renderPromptTemplate } from "@boboddy/sdk/definitions/steps";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "../../../common/contracts/uuid-v7";
import {
  buildContainerStepArtifactsDir,
  buildPromptRenderContext,
  buildRunningMetadata,
  resolveBaseWorkBranch,
} from "./process-claimed-step-execution-helpers";
import {
  resolveProjectWorkLogger,
  resolveProjectWorkReporter,
} from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  StartedClaimedExecution,
  StepExecutionRunTracker,
  StepExecutionWorkerClaim,
  StepExecutionWorkerClient,
} from "../contracts/process-project-work-types";
import type { WorkReporter } from "../contracts/work-reporter";

/**
 * The subset of {@link StepExecutionLogStream} this module drives: attaching
 * the in-container OpenCode log tail and the structured conversation stream
 * once their respective prerequisites (container, agent session) exist.
 */
type ClaimedExecutionLogStream = {
  registerSecretValues(values: readonly string[]): void;
  attachOpencodeTail(input: {
    runtimeContainerId: string | null;
    opencodeLogDirectory: string;
    hostAgentLogPath?: string | null | undefined;
  }): void;
  attachConversationStream(input: {
    agentBaseUrl: string;
    workspaceFolder: string;
    sessionId: string;
  }): void;
  shipDevcontainerLogLine(
    line: string,
    level: "info" | "warn" | "error",
  ): void;
};

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
    runtimeContainerId: string | null;
    agentBaseUrl: string;
    resolvedBranch: string;
    devcontainerConfigPath: string;
    aiImage: string;
    networkName: string;
  },
) {
  await tracker.markRunning({
    id: input.localRuntimeSessionId,
    workspacePath: input.workspacePath,
    runtimeContainerId: input.runtimeContainerId,
    agentBaseUrl: input.agentBaseUrl,
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

/**
 * Select the runtime orchestrator for the step's execution mode. `no_workspace`
 * steps run OpenCode directly on the host (no clone, no devcontainer) via the
 * dedicated orchestrator; everything else uses the default workspace path.
 */
function resolveRuntimeEnvironmentOrchestrator(
  deps: ProcessProjectWorkDeps,
  executionMode: "workspace" | "no_workspace",
) {
  if (executionMode === "no_workspace") {
    if (!deps.noWorkspaceRuntimeEnvironmentOrchestrator) {
      throw new Error(
        "Step requires no_workspace execution mode but no " +
          "noWorkspaceRuntimeEnvironmentOrchestrator is configured.",
      );
    }
    return deps.noWorkspaceRuntimeEnvironmentOrchestrator;
  }
  return deps.runtimeEnvironmentOrchestrator;
}

async function launchRuntimeEnvironment(
  deps: ProcessProjectWorkDeps,
  input: {
    localRuntimeSessionId: UuidV7;
    workerContext: Awaited<ReturnType<typeof fetchWorkerContext>>;
    requestedByUserId: UuidV7;
    reporter: WorkReporter;
    stepExecutionId: string;
    onDevcontainerLogLine?:
      | ((line: string, level: "info" | "warn" | "error") => void)
      | undefined;
  },
) {
  const orchestrator = resolveRuntimeEnvironmentOrchestrator(
    deps,
    input.workerContext.stepDefinition.executionMode,
  );
  return await orchestrator.launch({
    sessionId: input.localRuntimeSessionId,
    projectId: parseUuidV7(input.workerContext.projectId),
    requestedByUserId: input.requestedByUserId,
    gitUrl: input.workerContext.gitUrl,
    baseWorkBranch: resolveBaseWorkBranch(input.workerContext.baseWorkBranch),
    stepKey: input.workerContext.stepDefinition.key,
    opencodeMcpJson: input.workerContext.stepDefinition.opencodeMcpJson,
    opencodePluginJson: input.workerContext.stepDefinition.opencodePluginJson,
    // The step prompt is delivered solely as the user message via promptAsync
    // below. We deliberately do NOT also set it as the build agent's system
    // prompt: doing so duplicated the entire prompt in every request (system +
    // user). On the OpenAI ChatGPT/OAuth path (store:false + encrypted
    // reasoning), that whole payload is re-uploaded on every turn and retry,
    // which inflates requests enough to trip mid-stream `server_error`s that
    // never occur for the smaller, single-message prompts used directly on a
    // workstation. Leaving this unset keeps opencode's default build agent
    // system prompt, matching local usage.
    currentExecutionInfo: {
      stepExecutionId: input.workerContext.stepExecution.id,
      resultSchemaJson: input.workerContext.stepDefinition.resultSchemaJson,
    },
    reporter: input.reporter,
    stepExecutionId: input.stepExecutionId,
    onDevcontainerLogLine: input.onDevcontainerLogLine,
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
  logStream?: ClaimedExecutionLogStream,
): Promise<StartedClaimedExecution> {
  const logger = resolveProjectWorkLogger(deps);
  const reporter = resolveProjectWorkReporter(deps);
  const localRuntimeSessionId = createUuidV7();

  reporter.event({
    type: "step:starting",
    stepExecutionId: input.claim.stepExecution.id,
  });
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
      baseWorkBranch: workerContext.baseWorkBranch ?? null,
      stepDefinitionKey: workerContext.stepDefinition.key,
      stepDefinitionName: workerContext.stepDefinition.name,
      sessionTitle: workerContext.agentPrompt.sessionTitle,
      promptLength: workerContext.agentPrompt.promptText.length,
    });

    logger.log("step", "Launching runtime environment", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
    });
    reporter.event({
      type: "step:runtime-launching",
      stepExecutionId: input.claim.stepExecution.id,
    });
    const environment = await launchRuntimeEnvironment(deps, {
      localRuntimeSessionId,
      workerContext,
      requestedByUserId: input.requestedByUserId,
      reporter,
      stepExecutionId: input.claim.stepExecution.id,
      onDevcontainerLogLine: logStream
        ? (line, level) => { logStream.shipDevcontainerLogLine(line, level); }
        : undefined,
    });
    cleanup = async () => {
      await environment.cleanup();
    };
    // Register the provider token(s) injected into the container (Path B) with
    // the log masker BEFORE attaching the in-container log tail below — that
    // tail mirrors the raw OpenCode log, which can echo those values. Path A
    // (.boboddy/.env) values were already seeded when the stream was created.
    logStream?.registerSecretValues(environment.secretValues);
    // Now that the runtime container exists, start mirroring the in-container
    // OpenCode log into the `ai-server` stream of the same feed.
    logStream?.attachOpencodeTail({
      runtimeContainerId: environment.runtimeContainerId,
      opencodeLogDirectory: environment.opencodeLogDirectory,
      hostAgentLogPath: environment.hostAgentLogPath,
    });
    logger.log("step", "Runtime environment launched", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
      workspacePath: environment.workspacePath,
      resolvedBranch: environment.resolvedBranch,
      devcontainerConfigPath: environment.devcontainerConfigPath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: environment.agentBaseUrl,
      aiImage: environment.aiImage,
      networkName: environment.networkName,
    });
    reporter.event({
      type: "step:runtime-ready",
      stepExecutionId: input.claim.stepExecution.id,
    });

    // Render the prompt now that the runtime is up: artifact paths embedded in
    // the prompt must be anchored at the resolved workspace folder OpenCode
    // operates against (no longer a hardcoded `/workspace`).
    const containerStepArtifactsDir = buildContainerStepArtifactsDir(
      environment.workspaceFolder,
    );
    const renderedStepInstructions = renderPromptTemplate(
      workerContext.stepDefinition.prompt,
      buildPromptRenderContext({
        inputJson: workerContext.stepExecution.inputJson,
        env: process.env,
        artifactsDir: `${containerStepArtifactsDir}/`,
      }),
    );
    const resolvedPromptText = workerContext.agentPrompt.promptText.replaceAll(
      workerContext.agentPrompt.stepInstructionsPlaceholder,
      renderedStepInstructions,
    );

    await markTrackedSessionRunning(tracker, {
      localRuntimeSessionId,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: environment.agentBaseUrl,
      resolvedBranch: environment.resolvedBranch,
      devcontainerConfigPath: environment.devcontainerConfigPath,
      aiImage: environment.aiImage,
      networkName: environment.networkName,
    });
    logger.log("step", "Marked local runtime session as running", {
      localRuntimeSessionId,
      stepExecutionId: input.claim.stepExecution.id,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
    });

    const stepArtifactsDir = path.join(
      environment.workspacePath,
      ".boboddy",
      "step-artifacts",
    );
    await mkdir(stepArtifactsDir, { recursive: true });

    // Request-size diagnostic: the OpenAI ChatGPT/OAuth path is far more likely
    // to fail mid-stream on large requests, and request size here is dominated
    // by the user prompt plus every configured MCP server's tool schemas. Log a
    // profile so oversized runs are identifiable from worker logs alone.
    const stepMcpServerNames = Object.keys(
      workerContext.stepDefinition.opencodeMcpJson ?? {},
    );
    logger.log("step", "Prepared step prompt request profile", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
      userPromptChars: resolvedPromptText.length,
      mcpServerCount: stepMcpServerNames.length,
      mcpServerNames: stepMcpServerNames,
    });

    logger.log("step", "Starting agent run", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
      agentBaseUrl: environment.agentBaseUrl,
      sessionTitle: workerContext.agentPrompt.sessionTitle,
      stepArtifactsDir,
    });
    reporter.event({
      type: "step:agent-running",
      stepExecutionId: input.claim.stepExecution.id,
    });
    const agentRunResult = await deps.agentRunner.promptAsync({
      agentBaseUrl: environment.agentBaseUrl,
      workspaceFolder: environment.workspaceFolder,
      sessionTitle: workerContext.agentPrompt.sessionTitle,
      promptText: resolvedPromptText,
      agent: "build",
    });
    logger.log("step", "Agent session started", {
      stepExecutionId: input.claim.stepExecution.id,
      agentSessionId: agentRunResult.sessionId,
    });

    // Now that the agent session exists, mirror the structured conversation
    // (model text, reasoning, tool calls) into the `conversation` stream of the
    // same feed via the in-container OpenCode event subscription.
    logStream?.attachConversationStream({
      agentBaseUrl: environment.agentBaseUrl,
      workspaceFolder: environment.workspaceFolder,
      sessionId: agentRunResult.sessionId,
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
    const failureReason = error instanceof Error ? error.message : String(error);
    logger.error("step", "Claimed step execution failed", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
      error,
    });
    reporter.event({
      type: "step:failed",
      stepExecutionId: input.claim.stepExecution.id,
      reason: failureReason,
    });
    // failClaimedStepIfStillRunning is intentionally NOT called here. The
    // log shipper's final flush must complete before the step is marked
    // failed — otherwise the API rejects log appends once the status
    // leaves "running". The caller (scheduleClaimedStepExecutionJob) owns
    // that call, after awaiting logStream.stop().
    await markTrackedSessionFailed(tracker, {
      localRuntimeSessionId,
      failureReason,
      metadataJson: JSON.stringify({
        finalStepStatus: "failed",
      }),
    });
    logger.log("step", "Marked local runtime session failed after error", {
      localRuntimeSessionId,
      stepExecutionId: input.claim.stepExecution.id,
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
