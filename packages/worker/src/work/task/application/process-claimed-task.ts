import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { HealthCheck } from "@boboddy/sdk/health-checks";
import { assertNever } from "../../../common/assert-never";
import { createUuidV7, type UuidV7 } from "../../../common/contracts/uuid-v7";
import { planStepEnv } from "./resolve-step-env";
import { taskKindUsesAgent } from "./task-kind-runtime";
import { runAgentStepBranch } from "./process-claimed-task-agent-branch";
import { runCodeStepBranch } from "./process-claimed-task-code-branch";
import {
  fetchWorkerContext,
  launchRuntimeEnvironment,
} from "./process-claimed-task-launch";
import {
  attachTrackedAgentSession,
  createTrackedSession,
  markTrackedSessionFailed,
  markTrackedSessionRunning,
} from "./process-claimed-task-tracker";
import {
  resolveProjectWorkLogger,
  resolveProjectWorkReporter,
} from "./process-project-work-logger";
import { toOpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";
import type {
  OpencodeServerHandle,
  ProcessProjectWorkDeps,
  StartedClaimedTask,
  TaskRunTracker,
  TaskWorkerClaim,
  TaskWorkerClient,
} from "../contracts/process-project-work-types";
import type { FakeAiServer } from "../infra/fake-ai";
import {
  runDeclaredHealthChecksOrThrow,
  startHealthCheckHarnessIfDeclared,
} from "./health-check-gate";

/**
 * The subset of {@link TaskLogStreaming} this module drives: attaching
 * the in-container OpenCode log tail and the structured conversation stream
 * once their respective prerequisites (container, agent session) exist.
 */
type ClaimedTaskLogStream = {
  registerSecretValues(values: readonly string[]): void;
  attachOpencodeTail(input: {
    runtimeContainerId: string | null;
    opencodeLogDirectory: string;
    hostAgentLogPath?: string | null | undefined;
  }): void;
  attachConversationStream(input: {
    server: OpencodeServerHandle;
    sessionId: string;
  }): void;
  shipDevcontainerLogLine(line: string, level: "info" | "warn" | "error"): void;
};

export async function startProcessClaimedTask(
  input: {
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    claim: TaskWorkerClaim;
    leaseDurationSeconds: number;
    /** See `ProcessProjectWorkInput.sourceBranch`. */
    sourceBranch?: string | null | undefined;
    /** See `ProcessProjectWorkInput.workerEnv`. */
    workerEnv?: Readonly<Record<string, string | undefined>> | undefined;
    /**
     * `boboddy work -k`: keep the runtime (container, workspace, on-disk
     * artifacts) when startup fails — during the launch itself or afterwards
     * (e.g. a failed health check) — so the failure can be inspected. The
     * monitor's `cleanupRuntime` covers failures after a successful start.
     */
    preserveRuntimeOnFailure?: boolean | undefined;
  },
  deps: ProcessProjectWorkDeps,
  client: TaskWorkerClient,
  tracker: TaskRunTracker,
  logStream?: ClaimedTaskLogStream,
): Promise<StartedClaimedTask> {
  const logger = resolveProjectWorkLogger(deps);
  const reporter = resolveProjectWorkReporter(deps);
  const localRuntimeSessionId = createUuidV7();

  reporter.event({
    type: "task:starting",
    taskId: input.claim.task.id,
  });
  logger.log("step", "Starting claimed task", {
    projectId: input.projectId,
    requestedByUserId: input.requestedByUserId,
    taskId: input.claim.task.id,
    claimToken: input.claim.claimToken,
    localRuntimeSessionId,
    leaseDurationSeconds: input.leaseDurationSeconds,
  });
  let cleanup: (() => Promise<void>) | null = null;
  let taskId: UuidV7 = input.claim.task.id;
  // The fake-AI harness (#120): only started for a step that declares
  // `healthChecks`, stopped again as soon as those checks finish (success or
  // failure) — well before the agent is prompted. Tracked here (rather than
  // scoped to the `try` block) so the `catch` block can stop it too if
  // something throws before the normal stop point is reached.
  let fakeAiServer: FakeAiServer | undefined;

  await createTrackedSession(tracker, {
    localRuntimeSessionId,
    projectId: input.projectId,
    taskId: input.claim.task.id,
  });
  logger.log("step", "Created local runtime session record", {
    localRuntimeSessionId,
    taskId: input.claim.task.id,
  });

  try {
    logger.log("step", "Fetching worker context", {
      taskId: input.claim.task.id,
    });
    const workerContext = await fetchWorkerContext(client, input.claim);
    logger.log("step", "Fetched worker context", {
      taskId: input.claim.task.id,
      workerContextProjectId: workerContext.projectId,
      gitUrl: workerContext.gitUrl,
      baseWorkBranch: workerContext.baseWorkBranch ?? null,
      stepDefinitionKey: workerContext.task.key,
      stepDefinitionName: workerContext.task.name,
      sessionTitle: workerContext.agentPrompt.sessionTitle,
      promptLength: workerContext.agentPrompt.promptText.length,
    });

    // Resolved before anything launches so a missing required variable fails
    // fast, and its secrets are masked before any runtime log can echo them.
    // Variables inferred from MCP server refs are resolved by the launch once
    // it has discovered them (`resolveMcpEnv`), and masked via its secrets.
    const workerEnv = input.workerEnv ?? process.env;
    const {
      resolved: { stepEnv, setupEnv, promptEnv, secretValues },
      resolveMcpEnv,
    } = planStepEnv({
      envJson: workerContext.runtime.envJson,
      inputJson: workerContext.task.inputJson,
      workerEnv,
      opencodeMcpJson: workerContext.runtime.opencodeMcpJson,
    });
    logStream?.registerSecretValues(secretValues);

    // Steps whose kind does not prompt an agent (`code`: a plain function run
    // in the devcontainer) never declare health checks (no prompting harness
    // to gate), never get an OpenCode server, and skip prompt rendering. The
    // runtime environment (launch, work-branch checkout) stays required
    // exactly as for an agent step.
    const { kind } = workerContext.task;
    const usesAgent = taskKindUsesAgent(kind);

    // A step declaring no health checks must be byte-identical to today: no
    // fake-AI harness starts, no synthetic provider is registered, and
    // `fakeAiProviderOverride` stays unset below.
    const declaredHealthChecks: HealthCheck[] = usesAgent
      ? (workerContext.runtime.healthChecksJson ?? [])
      : [];
    const harness = usesAgent
      ? await startHealthCheckHarnessIfDeclared({
          healthChecks: declaredHealthChecks,
          isNoWorkspace: workerContext.runtime.executionMode === "no_workspace",
          createFakeAiServer: deps.createFakeAiServer,
        })
      : { fakeAiServer: undefined, fakeAiProviderOverride: undefined };
    fakeAiServer = harness.fakeAiServer;

    logger.log("step", "Launching runtime environment", {
      taskId: input.claim.task.id,
      localRuntimeSessionId,
      declaredHealthCheckCount: declaredHealthChecks.length,
    });
    reporter.event({
      type: "task:runtime-launching",
      taskId: input.claim.task.id,
    });
    const environment = await launchRuntimeEnvironment(deps, {
      startAgent: usesAgent,
      localRuntimeSessionId,
      workerContext,
      requestedByUserId: input.requestedByUserId,
      reporter,
      taskId: input.claim.task.id,
      sourceBranch: input.sourceBranch,
      onDevcontainerLogLine: logStream
        ? (line, level) => {
            logStream.shipDevcontainerLogLine(line, level);
          }
        : undefined,
      // Host runs: mirror the serve log from the moment it exists, so a startup
      // failure (bad config, crash) is streamed instead of lost with the
      // session home on cleanup. Secrets first — the raw log can echo them.
      onAgentLogReady: logStream
        ? ({ logDirectory, hostLogPath, secretValues }) => {
            logStream.registerSecretValues(secretValues);
            logStream.attachOpencodeTail({
              runtimeContainerId: null,
              opencodeLogDirectory: logDirectory,
              hostAgentLogPath: hostLogPath,
            });
          }
        : undefined,
      fakeAiProviderOverride: harness.fakeAiProviderOverride,
      stepEnv,
      setupEnv,
      resolveMcpEnv,
      preserveRuntimeOnFailure: input.preserveRuntimeOnFailure,
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
    if (environment.agent) {
      logStream?.attachOpencodeTail({
        runtimeContainerId: environment.runtimeContainerId,
        opencodeLogDirectory: environment.agent.logDirectory,
        hostAgentLogPath: environment.agent.hostLogPath,
      });
    }
    logger.log("step", "Runtime environment launched", {
      taskId: input.claim.task.id,
      localRuntimeSessionId,
      workspacePath: environment.workspacePath,
      resolvedBranch: environment.resolvedBranch,
      devcontainerConfigPath: environment.devcontainerConfigPath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: environment.agent?.baseUrl ?? null,
      aiImage: environment.aiImage,
      networkName: environment.networkName,
    });
    reporter.event({
      type: "task:runtime-ready",
      taskId: input.claim.task.id,
    });

    // The health check gate (#120): a required failure throws here, before
    // any provider tokens are spent and before the prompt is even rendered.
    // A gate, not a race — see `run-health-checks.ts` for why checks are not
    // run concurrently with the agent. The forced call's announcement and
    // the tool's output land in the durable log feed for free: the in-container
    // OpenCode log tail was already attached above, before this point.
    if (fakeAiServer) {
      const healthCheckAgent = environment.agent;
      if (!healthCheckAgent) {
        throw new Error(
          "Health checks require a running agent, but the runtime environment launched without one",
        );
      }
      try {
        await runDeclaredHealthChecksOrThrow({
          fakeAiServer,
          server: toOpencodeServerHandle(
            healthCheckAgent,
            environment.workspaceFolder,
          ),
          healthChecks: declaredHealthChecks,
          runHealthChecksOverride: deps.runHealthChecks,
          logger,
          reporter,
          taskId: input.claim.task.id,
        });
      } finally {
        // Already stopped internally; cleared so the `catch` block below
        // doesn't try to stop it again.
        fakeAiServer = undefined;
      }
    }

    await markTrackedSessionRunning(tracker, {
      localRuntimeSessionId,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: environment.agent?.baseUrl ?? null,
      resolvedBranch: environment.resolvedBranch,
      devcontainerConfigPath: environment.devcontainerConfigPath,
      aiImage: environment.aiImage,
      networkName: environment.networkName,
    });
    logger.log("step", "Marked local runtime session as running", {
      localRuntimeSessionId,
      taskId: input.claim.task.id,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
    });

    const stepArtifactsDir = path.join(
      environment.workspacePath,
      ".boboddy",
      "step-artifacts",
    );
    await mkdir(stepArtifactsDir, { recursive: true });

    switch (kind) {
      case "code": {
        await runCodeStepBranch({
          deps,
          logger,
          reporter,
          workerContext,
          environment,
          taskId: input.claim.task.id,
          localRuntimeSessionId,
          stepEnv,
        });
        taskId = input.claim.task.id;
        return {
          projectId: input.projectId,
          localRuntimeSessionId,
          taskId,
          claimToken: input.claim.claimToken,
          agentSessionId: null,
          environment,
        };
      }
      case "agent": {
        const agentSessionId = await runAgentStepBranch({
          deps,
          logger,
          reporter,
          workerContext,
          environment,
          taskId: input.claim.task.id,
          localRuntimeSessionId,
          stepArtifactsDir,
          workerEnv,
          promptEnv,
          onSessionCreated: (sessionId, server) => {
            logStream?.attachConversationStream({ server, sessionId });
          },
        });
        await attachTrackedAgentSession(
          tracker,
          localRuntimeSessionId,
          agentSessionId,
        );
        logger.log("step", "Attached agent session to local runtime session", {
          localRuntimeSessionId,
          agentSessionId,
        });
        taskId = input.claim.task.id;
        return {
          projectId: input.projectId,
          localRuntimeSessionId,
          taskId,
          claimToken: input.claim.claimToken,
          agentSessionId,
          environment,
        };
      }
      default:
        return assertNever(kind);
    }
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : String(error);
    logger.error("step", "Claimed task failed", {
      taskId: input.claim.task.id,
      localRuntimeSessionId,
      error,
    });
    reporter.event({
      type: "task:failed",
      taskId: input.claim.task.id,
      reason: failureReason,
    });
    // failClaimedTaskIfStillRunning is intentionally NOT called here. The
    // log shipper's final flush must complete before the step is marked
    // failed — otherwise the API rejects log appends once the status
    // leaves "running". The caller (scheduleClaimedTaskJob) owns
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
      taskId: input.claim.task.id,
    });
    logger.log("step", "Cleaning up startup artifacts after failure", {
      taskId,
      localRuntimeSessionId,
      hasCleanup: cleanup !== null,
    });
    // Normally already stopped (and cleared) right after health checks
    // complete; only still set here if something threw before that point
    // (e.g. the runtime launch itself failed).
    if (fakeAiServer) {
      // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
      await fakeAiServer.stop().catch((stopError: unknown) => {
        logger.error(
          "step",
          "Failed to stop the fake AI server after failure",
          {
            taskId: input.claim.task.id,
            error:
              stopError instanceof Error
                ? stopError.message
                : String(stopError),
          },
        );
      });
    }
    if (input.preserveRuntimeOnFailure) {
      logger.log("step", "Preserving runtime environment after failure", {
        taskId,
        localRuntimeSessionId,
      });
    } else {
      await cleanup?.();
    }
    throw error;
  }
}
