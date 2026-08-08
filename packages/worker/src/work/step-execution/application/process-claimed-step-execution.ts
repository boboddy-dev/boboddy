import { mkdir } from "node:fs/promises";
import path from "node:path";
import { renderPromptTemplate } from "@boboddy/sdk/definitions/steps";
import type { HealthCheck } from "@boboddy/sdk/health-checks";
import { createUuidV7, type UuidV7 } from "../../../common/contracts/uuid-v7";
import {
  buildContainerStepArtifactsDir,
  buildPromptRenderContext,
} from "./process-claimed-step-execution-helpers";
import {
  fetchWorkerContext,
  launchRuntimeEnvironment,
} from "./process-claimed-step-execution-launch";
import {
  attachTrackedAgentSession,
  createTrackedSession,
  markTrackedSessionFailed,
  markTrackedSessionRunning,
} from "./process-claimed-step-execution-tracker";
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
import type { FakeAiServer } from "../infra/fake-ai";
import {
  runDeclaredHealthChecksOrThrow,
  startHealthCheckHarnessIfDeclared,
} from "./health-check-gate";

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

export async function startProcessClaimedExecution(
  input: {
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    claim: StepExecutionWorkerClaim;
    leaseDurationSeconds: number;
    /** See `ProcessProjectWorkInput.sourceBranch`. */
    sourceBranch?: string | null | undefined;
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
  // The fake-AI harness (#120): only started for a step that declares
  // `healthChecks`, stopped again as soon as those checks finish (success or
  // failure) — well before the agent is prompted. Tracked here (rather than
  // scoped to the `try` block) so the `catch` block can stop it too if
  // something throws before the normal stop point is reached.
  let fakeAiServer: FakeAiServer | undefined;

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

    // A step declaring no health checks must be byte-identical to today: no
    // fake-AI harness starts, no synthetic provider is registered, and
    // `fakeAiProviderOverride` stays unset below.
    const declaredHealthChecks: HealthCheck[] =
      workerContext.stepDefinition.healthChecksJson ?? [];
    const harness = await startHealthCheckHarnessIfDeclared({
      healthChecks: declaredHealthChecks,
      isNoWorkspace:
        workerContext.stepDefinition.executionMode === "no_workspace",
      createFakeAiServer: deps.createFakeAiServer,
    });
    fakeAiServer = harness.fakeAiServer;

    logger.log("step", "Launching runtime environment", {
      stepExecutionId: input.claim.stepExecution.id,
      localRuntimeSessionId,
      declaredHealthCheckCount: declaredHealthChecks.length,
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
      sourceBranch: input.sourceBranch,
      onDevcontainerLogLine: logStream
        ? (line, level) => { logStream.shipDevcontainerLogLine(line, level); }
        : undefined,
      fakeAiProviderOverride: harness.fakeAiProviderOverride,
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

    // The health check gate (#120): a required failure throws here, before
    // any provider tokens are spent and before the prompt is even rendered.
    // A gate, not a race — see `run-health-checks.ts` for why checks are not
    // run concurrently with the agent. The forced call's announcement and
    // the tool's output land in the durable log feed for free: the in-container
    // OpenCode log tail was already attached above, before this point.
    if (fakeAiServer) {
      try {
        await runDeclaredHealthChecksOrThrow({
          fakeAiServer,
          agentBaseUrl: environment.agentBaseUrl,
          workspaceFolder: environment.workspaceFolder,
          healthChecks: declaredHealthChecks,
          runHealthChecksOverride: deps.runHealthChecks,
          logger,
          reporter,
          stepExecutionId: input.claim.stepExecution.id,
        });
      } finally {
        // Already stopped internally; cleared so the `catch` block below
        // doesn't try to stop it again.
        fakeAiServer = undefined;
      }
    }

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
    // Normally already stopped (and cleared) right after health checks
    // complete; only still set here if something threw before that point
    // (e.g. the runtime launch itself failed).
    if (fakeAiServer) {
      // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
      await fakeAiServer.stop().catch((stopError: unknown) => {
        logger.error("step", "Failed to stop the fake AI server after failure", {
          stepExecutionId: input.claim.stepExecution.id,
          error:
            stopError instanceof Error ? stopError.message : String(stopError),
        });
      });
    }
    await cleanup?.();
    throw error;
  }
}
