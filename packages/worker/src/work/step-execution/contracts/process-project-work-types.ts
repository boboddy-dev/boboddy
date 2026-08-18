import type { ArtifactKind } from "@boboddy/sdk/contracts/artifacts";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type { ArtifactStore } from "../../../artifacts/artifact-store/domain/artifact-store";
import type { FakeAiServer } from "../infra/fake-ai/fake-ai-server";
import type {
  StepExecutionContract,
  StepExecutionWorkerContextContract,
} from "./step-execution-contracts";
import type { CurrentExecutionInfo } from "../application/process-project-work-findings";
import type {
  RunHealthChecksInput,
  HealthCheckReport,
} from "../application/run-health-checks";
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
  /**
   * The user's resolved (or explicitly overridden) current local branch at
   * `boboddy work` invocation (see `resolveSourceBranch`). Applied uniformly
   * to every claim processed during this run, but only takes effect for the
   * FIRST step of a pipeline attempt — later steps always chain off the
   * predecessor's `workBranch` via the server-handed `baseWorkBranch`, which
   * takes precedence over this value. `null`/`undefined` when not resolved
   * (e.g. cwd isn't a git repo, or on a detached HEAD).
   */
  sourceBranch?: string | null | undefined;
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
    /**
     * The `boboddy/...` branch the agent committed to, and the branch it was
     * created off of. Sent as dedicated fields (NOT inside `resultJson`). Null
     * for runs without a step key (e.g. no_workspace) or nothing was committed.
     */
    workBranch: string | null;
    createdFromBranch: string | null;
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
    /**
     * The artifact's byte size, known here because the store reads the full
     * file into memory before requesting the upload URL (see
     * `RemoteArtifactStore.saveArtifact`). Passed through so the API's
     * pre-flight usage guard can check real storage headroom instead of only
     * the write-count cap.
     */
    sizeBytes?: number | undefined;
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
   *
   * For `no_workspace` runs OpenCode runs directly on the host, so this is the
   * host temp working directory (there is no container).
   */
  workspaceFolder: string;
  opencodeLogDirectory: string;
  resolvedBranch: string;
  /**
   * The `boboddy/...` branch the agent commits to, created off the checked-out
   * base. `null` for `no_workspace` runs (no repo) or runs without a step key.
   */
  workBranch: string | null;
  /**
   * The branch {@link workBranch} was created off of (the resolved clone branch
   * for the first step, or the previous step's work branch for later steps).
   * `null` when there is no work branch.
   */
  createdFromBranch: string | null;
  /**
   * Commit the agent's changes to {@link workBranch} and push it. Invoked while
   * the workspace still exists and the step is still `running` (before cleanup /
   * completion). Absent when there is no work branch (feature off / no_workspace).
   * Implementations must not throw on push failure (findings remain valid).
   */
  commitAndPushWorkBranch?: (() => Promise<void>) | undefined;
  devcontainerConfigPath: string;
  /**
   * Single runtime container id. With the single-container model OpenCode runs
   * inside the devcontainer, so this is the devcontainer id (collapses the
   * former `devcontainerId` + `aiContainerId` pair).
   *
   * `null` for `no_workspace` runs, where OpenCode runs directly on the host as
   * a plain child process and there is no container. Callers must treat a null
   * id as "not a container" (skip container-only concerns like `docker exec`
   * health checks / log tailing).
   */
  runtimeContainerId: string | null;
  /**
   * Host log file the agent's stdout/stderr is written to for `no_workspace`
   * runs (tailed directly from the host). `null`/absent for container runs,
   * where {@link opencodeLogDirectory} + `docker exec` tailing is used instead.
   */
  hostAgentLogPath?: string | null | undefined;
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
    /**
     * The branch a later step must be created off of, handed down by the server
     * (the predecessor step's work branch). Takes precedence over any repo-local
     * configured base branch. Null for the first step.
     */
    baseWorkBranch?: string | null | undefined;
    /**
     * The CLI's resolved (or explicitly overridden) current local branch at
     * `boboddy work` invocation. Checked out immediately after clone for the
     * FIRST step of a pipeline attempt only (i.e. when {@link baseWorkBranch}
     * above is absent) — takes precedence over the repo-local configured base
     * branch, which in turn falls back to the cloned default branch. Ignored
     * entirely when {@link baseWorkBranch} is present (a later step).
     */
    sourceBranch?: string | null | undefined;
    /** Step key used (sanitized) in the work branch name `boboddy/<key>-<id>`. */
    stepKey?: string | undefined;
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
      ((line: string, level: "info" | "warn" | "error") => void) | undefined;
    /**
     * Opt-in hook that bakes a fake AI provider into the launch-time inline
     * config, pointed at `baseUrl`, instead of PATCHing `/config` on an
     * already-running agent (proven to have zero live effect — see #109).
     * Set by `run --dry-run` (#109/#110) and, since #120, by real step
     * execution for steps that declare `healthChecks` — a step declaring none
     * never sets this field, so it launches unaffected exactly as before.
     */
    fakeAiProviderOverride?: { baseUrl: string } | undefined;
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
    /**
     * Invoked as soon as the OpenCode session exists, but before the prompt
     * text is submitted to it. The caller uses this to attach its
     * conversation-event SSE subscription (`attachConversationStream`) ahead
     * of the prompt submission — OpenCode broadcasts the initial user
     * message's `message.part.updated` event exactly once, synchronously as
     * part of handling the prompt request, so a subscriber that attaches
     * only after `promptAsync` resolves permanently misses it. Awaited before
     * the prompt is sent, so the subscription is guaranteed live first.
     */
    onSessionCreated?: (input: { sessionId: string }) => void | Promise<void>;
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
    /** `null` for `no_workspace` runs, which have no container. */
    runtimeContainerId: string | null;
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
  /**
   * Orchestrator for the default `workspace` execution mode: clones the repo,
   * launches the devcontainer, and runs OpenCode inside it.
   */
  runtimeEnvironmentOrchestrator: StepExecutionRuntimeEnvironmentOrchestrator;
  /**
   * Orchestrator for `no_workspace` steps: runs OpenCode directly on the host
   * against a throwaway temp working dir, with NO git clone and NO devcontainer.
   * Optional — when a `no_workspace` step is claimed but this is omitted, the
   * launch fails fast rather than silently cloning. Wired by default in
   * `loadDefaultDeps`.
   */
  noWorkspaceRuntimeEnvironmentOrchestrator?:
    StepExecutionRuntimeEnvironmentOrchestrator | undefined;
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
  /**
   * The health check runner (#119/#120). Overridable so unit tests can inject
   * a fake without exercising the real forced-tool-call machinery — the same
   * seam {@link agentRunner} already provides. Defaults to the real
   * `runHealthChecks` when omitted. Only ever invoked for a step that
   * declares a non-empty `healthChecks`.
   */
  runHealthChecks?:
    | ((input: RunHealthChecksInput) => Promise<HealthCheckReport[]>)
    | undefined;
  /**
   * Factory for the fake-AI harness a health-check-declaring step's forced
   * tool calls run through. Overridable for the same reason as
   * {@link runHealthChecks}. Defaults to `() => new FakeAiServer()`.
   */
  createFakeAiServer?: (() => FakeAiServer) | undefined;
};
