import type { ArtifactKind } from "@boboddy/sdk/contracts/artifacts";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type { ArtifactStore } from "../../../artifacts/artifact-store/domain/artifact-store";
import type {
  StepExecutionContract,
  StepExecutionWorkerContextContract,
} from "./step-execution-contracts";
import type { CurrentExecutionInfo } from "../application/process-project-work-findings";
import type { WorkReporter } from "./work-reporter";

export type ProcessProjectWorkInput = {
  projectId: UuidV7;
  batchSize: number;
  concurrency: number;
  pollIntervalMs: number;
  leaseDurationSeconds: number;
  workerId: string;
  workItemId?: string | undefined;
  preserveRuntimeOnComplete?: boolean | undefined;
  once?: boolean | undefined;
  /**
   * Max time to wait for the agent session to first report `busy`/`retry`
   * before failing fast. Guards against a misconfigured agent/provider (e.g. an
   * unreachable AI host) that would otherwise poll `running: false` until the
   * caller's overall timeout. Defaults to {@link DEFAULT_SESSION_START_TIMEOUT_MS}
   * when omitted.
   */
  sessionStartTimeoutMs?: number | undefined;
  /**
   * Secret values ("Path A": the user's `.boboddy/.env` values) used to seed
   * each claimed step's log masker so they are redacted from the shipped feed.
   * These are opaque values, not a name→value map. The provider token(s)
   * ("Path B") are registered later, from the runtime launch result.
   */
  secretValues?: readonly string[] | undefined;
};

/**
 * Default cap on how long the monitor waits for the agent session to start
 * (report `busy`/`retry`) before failing fast. Sized to comfortably cover
 * OpenCode session creation + first model turn, while surfacing a broken
 * agent/provider connection in ~1 min instead of hanging.
 */
export const DEFAULT_SESSION_START_TIMEOUT_MS = 60_000;

/**
 * Fallback cap on the number of "waiting for the agent session to start" polls
 * when `pollIntervalMs` is 0 (so elapsed time never accrues). Keeps the
 * fail-fast guard effective in that degenerate configuration.
 */
export const DEFAULT_SESSION_START_MAX_POLLS = 60;

export type ProcessProjectWorkResult = {
  claimedCount: number;
  processedCount: number;
  skippedCount: number;
};

export type StepExecutionWorkerClaim = {
  stepExecution: {
    id: UuidV7;
  };
  claimToken: string;
};

export type StepExecutionWorkerContext = StepExecutionWorkerContextContract;

export type StepExecutionLogStream = "worker" | "ai-server" | "conversation";

export type StepExecutionLogLevel = "debug" | "info" | "warn" | "error";

export type StepExecutionLogLine = {
  seq: number;
  stream: StepExecutionLogStream;
  ts: string;
  content: string;
  level: StepExecutionLogLevel;
};

export type StepExecutionWorkerClient = {
  userId: UuidV7;
  claimStepExecutions(input: {
    projectId: UuidV7;
    workerId: string;
    batchSize: number;
    leaseDurationSeconds: number;
    workItemId?: string | undefined;
  }): Promise<StepExecutionWorkerClaim[]>;
  heartbeatStepExecution(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
    leaseDurationSeconds: number;
  }): Promise<void>;
  failStepExecution(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
  }): Promise<void>;
  completeStepExecution(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
  }): Promise<void>;
  appendStepExecutionLogs(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
    lines: StepExecutionLogLine[];
  }): Promise<{ nextOffset: number }>;
  getStepExecution(input: {
    stepExecutionId: UuidV7;
  }): Promise<Pick<StepExecutionContract, "status">>;
  getStepExecutionWorkerContext(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
  }): Promise<StepExecutionWorkerContextContract>;
  createArtifactUploadUrl(input: {
    stepExecutionId: string;
    claimToken: string;
    relativeStorePath: string;
    contentType?: string | undefined;
  }): Promise<{
    uploadUrl: string;
    storeRef: string;
    objectKey: string;
    expiresInSeconds: number;
  }>;
  recordArtifact(input: {
    stepExecutionId: string;
    claimToken: string;
    objectKey: string;
    relativeStorePath: string;
    sizeBytes: number;
    contentType?: string | undefined;
    kind: ArtifactKind;
  }): Promise<void>;
};

/**
 * Narrow port used by the remote artifact store to upload artifacts through the
 * API. The full {@link StepExecutionWorkerClient} satisfies this subset.
 */
export type RemoteArtifactUploader = Pick<
  StepExecutionWorkerClient,
  "createArtifactUploadUrl" | "recordArtifact"
>;

export type StepExecutionRuntimeEnvironment = {
  workspacePath: string;
  /**
   * Absolute path to the resolved workspace folder inside the runtime
   * container. Phase 1 populates this from the resolved devcontainer workspace
   * folder; Phase 0 only adds the field. Replaces the implicit `/workspace`
   * constant assumption.
   */
  workspaceFolder: string;
  opencodeLogDirectory: string;
  resolvedBranch: string;
  devcontainerConfigPath: string;
  /**
   * Single runtime container id. With the single-container model OpenCode runs
   * inside the devcontainer, so this is the devcontainer id (collapses the
   * former `devcontainerId` + `aiContainerId` pair).
   */
  runtimeContainerId: string;
  /** Runtime-neutral agent base URL (formerly `aiBaseUrl`). */
  agentBaseUrl: string;
  aiImage: string;
  networkName: string;
  /**
   * Secret values injected into the runtime container that must be redacted
   * from the log feed (the resolved provider token(s); "Path B"). Surfaced from
   * `launch` so the caller can register them with the step's log masker before
   * the in-container log tail — which can echo them — is attached. May be empty.
   */
  secretValues: readonly string[];
  checkContainerHealth?(): Promise<{
    runtimeContainerStatus: string;
  }>;
  cleanup(): Promise<void>;
};

export type StepExecutionRuntimeEnvironmentOrchestrator = {
  launch(input: {
    sessionId: UuidV7;
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    gitUrl: string;
    requestedBranch?: string | null | undefined;
    opencodeMcpJson?: StepExecutionWorkerContextContract["stepDefinition"]["opencodeMcpJson"];
    opencodePluginJson?: StepExecutionWorkerContextContract["stepDefinition"]["opencodePluginJson"];
    currentExecutionInfo: CurrentExecutionInfo;
    /** Optional reporter to emit granular sub-step progress events during launch. */
    reporter?: WorkReporter | undefined;
    stepExecutionId?: string | undefined;
    /**
     * Optional sink for individual devcontainer launch log lines, wired to the
     * step's log shipper so the CLI's real subprocess output streams to the
     * durable feed as it appears (separate from the presentation `reporter`).
     */
    onDevcontainerLogLine?:
      | ((line: string, level: "info" | "warn" | "error") => void)
      | undefined;
  }): Promise<StepExecutionRuntimeEnvironment>;
};

export type StepExecutionAgentRunner = {
  promptAsync(input: {
    agentBaseUrl: string;
    /**
     * Absolute path to the workspace folder the agent operates against (the
     * resolved runtime workspace folder). Used as the OpenCode client
     * `directory`; replaces the former hardcoded `/workspace`.
     */
    workspaceFolder: string;
    sessionTitle: string;
    promptText: string;
    agent: string;
  }): Promise<{
    sessionId: string;
  }>;
  getSessionStatus(input: {
    agentBaseUrl: string;
    workspaceFolder: string;
    sessionId: string;
  }): Promise<{
    running: boolean;
    /**
     * Present when opencode reports the session is retrying an upstream AI
     * request (e.g. an OpenAI `server_error`). Surfaced so the monitor can log
     * provider failures distinctly instead of burying them in the raw status.
     */
    providerError?:
      | {
          attempt: number;
          message: string;
        }
      | undefined;
  }>;
  sendRetryPrompt(input: {
    agentBaseUrl: string;
    workspaceFolder: string;
    sessionId: string;
    promptText: string;
    agent: string;
  }): Promise<void>;
};

export type StartedClaimedExecution = {
  projectId: UuidV7;
  localRuntimeSessionId: UuidV7;
  stepExecutionId: UuidV7;
  claimToken: string;
  agentSessionId: string;
  environment: StepExecutionRuntimeEnvironment;
};

export type StepExecutionRunTracker = {
  createSession(input: {
    id: string;
    projectId: string;
    stepExecutionId: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  markRunning(input: {
    id: string;
    workspacePath: string;
    runtimeContainerId: string;
    agentBaseUrl: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  attachAgentSession(input: {
    id: string;
    agentSessionId: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  markSucceeded(input: {
    id: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  markFailed(input: {
    id: string;
    failureReason: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  close(): void | Promise<void>;
};

export type ProjectWorkLogger = {
  debug(
    scope: string,
    message: string,
    details?: Record<string, unknown>,
  ): void;
  log(scope: string, message: string, details?: Record<string, unknown>): void;
  error(
    scope: string,
    message: string,
    details?: Record<string, unknown>,
  ): void;
};

export type { WorkEvent, WorkReporter, WorkTask } from "./work-reporter";

export type ProcessProjectWorkDeps = {
  workerClient: StepExecutionWorkerClient;
  createRunTracker(): StepExecutionRunTracker;
  runtimeEnvironmentOrchestrator: StepExecutionRuntimeEnvironmentOrchestrator;
  agentRunner: StepExecutionAgentRunner;
  artifactStore: ArtifactStore;
  sleep(milliseconds: number): Promise<void>;
  logger?: ProjectWorkLogger | undefined;
  /**
   * Optional user-facing presentation surface. Distinct from {@link logger}
   * (diagnostics). When omitted, milestone events are dropped (see
   * {@link resolveProjectWorkReporter}).
   */
  reporter?: WorkReporter | undefined;
};
