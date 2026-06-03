import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type { TimeProvider } from "../../../lib/time-provider";
import type { RuntimeCommandRunner } from "../../../runtime/runtime-service/application/runtime-command-runner";
import type { RuntimeServiceRunner } from "../../../runtime/runtime-service/application/runtime-service-runner";
import type { ArtifactStore } from "../../../artifacts/artifact-store/domain/artifact-store";
import type {
  StepExecutionContract,
  StepExecutionWorkerContextContract,
} from "./step-execution-contracts";
import type { CurrentExecutionInfo } from "../application/process-project-work-findings";

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
};

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
  getStepExecution(input: {
    stepExecutionId: UuidV7;
  }): Promise<Pick<StepExecutionContract, "status">>;
  getStepExecutionWorkerContext(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
  }): Promise<StepExecutionWorkerContextContract>;
};

export type StepExecutionRuntimeEnvironment = {
  workspacePath: string;
  opencodeLogDirectory: string;
  resolvedBranch: string;
  devcontainerConfigPath: string;
  devcontainerId: string;
  aiContainerId: string;
  aiBaseUrl: string;
  aiImage: string;
  networkName: string;
  checkContainerHealth?(): Promise<{
    devcontainerStatus: string;
    aiContainerStatus: string;
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
    agentPromptText: StepExecutionWorkerContextContract["agentPrompt"]["promptText"];
    currentExecutionInfo: CurrentExecutionInfo;
  }): Promise<StepExecutionRuntimeEnvironment>;
};

export type StepExecutionAgentRunner = {
  promptAsync(input: {
    aiBaseUrl: string;
    sessionTitle: string;
    promptText: string;
    agent: string;
  }): Promise<{
    sessionId: string;
  }>;
  getSessionStatus(input: { aiBaseUrl: string; sessionId: string }): Promise<{
    running: boolean;
  }>;
  sendRetryPrompt(input: {
    aiBaseUrl: string;
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
    devcontainerId: string;
    aiContainerId: string;
    aiBaseUrl: string;
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
  log(scope: string, message: string, details?: Record<string, unknown>): void;
  error(
    scope: string,
    message: string,
    details?: Record<string, unknown>,
  ): void;
};

export type ProcessProjectWorkDeps = {
  workerClient: StepExecutionWorkerClient;
  createRunTracker(): StepExecutionRunTracker;
  runtimeEnvironmentOrchestrator: StepExecutionRuntimeEnvironmentOrchestrator;
  agentRunner: StepExecutionAgentRunner;
  artifactStore: ArtifactStore;
  runtimeCommandRunner?: RuntimeCommandRunner | undefined;
  runtimeServiceRunner?: RuntimeServiceRunner | undefined;
  timeProvider?: TimeProvider | undefined;
  sleep(milliseconds: number): Promise<void>;
  logger?: ProjectWorkLogger | undefined;
};
