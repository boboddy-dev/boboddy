import os, { hostname } from "node:os";
import path from "node:path";
import type { DestinationStream } from "pino";
import { parseUuidV7 } from "../../../common/contracts/uuid-v7";
import type { ArtifactStore } from "../../../artifacts/artifact-store/domain/artifact-store";
import { LocalArtifactStore } from "../../../artifacts/artifact-store/infra/local-artifact-store";
import {
  processProjectWork as processProjectWorkInCore,
} from "./process-project-work";
import type {
  ProcessProjectWorkResult,
  ProjectWorkLogger,
  StepExecutionAgentRunner,
  StepExecutionRunTracker,
  StepExecutionRuntimeEnvironmentOrchestrator,
  StepExecutionWorkerClient,
  WorkReporter,
} from "../contracts/process-project-work-types";
import { resolveBoboddyBaseUrl } from "../../../auth/session/infra/auth-config";
import { createLogger } from "../../../lib/logger";
import {
  type LocalRuntimeSessionStore,
  SqliteLocalRuntimeSessionStore,
} from "../infra/sqlite-local-runtime-session-store";
import {
  DefaultLocalProjectRuntimeEnvironmentOrchestrator,
} from "../infra/local-project-runtime-environment";
import { DefaultOpencodeStepRunner } from "../infra/opencode-step-runner";
import { createStepExecutionPlaneWorkerClient } from "../infra/worker-api-client";

const DEFAULT_WORK_CONCURRENCY = 1;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_DURATION_SECONDS = 30;

export type ProcessProjectWorkOptions = {
  projectId: string;
  baseUrl?: string | undefined;
  batchSize?: number | undefined;
  concurrency?: number | undefined;
  pollIntervalMs?: number | undefined;
  leaseDurationSeconds?: number | undefined;
  workerId?: string | undefined;
  workItemId?: string | undefined;
  preserveRuntimeOnComplete?: boolean | undefined;
  once?: boolean | undefined;
  /** Fail-fast cap on waiting for the agent session to start (ms). */
  sessionStartTimeoutMs?: number | undefined;
  dest?: DestinationStream | undefined;
  /** Env vars read from .boboddy/.env in the user's local project directory. */
  localEnvVars?: Record<string, string> | undefined;
  /**
   * Optional user-facing presentation surface (spinners/status). Distinct from
   * the structured pino logger driven by {@link dest}. When omitted, no
   * human-facing output is rendered by the worker.
   */
  reporter?: WorkReporter | undefined;
};

export type ProcessProjectWorkDeps = {
  createWorkerClient(baseUrl: string): Promise<StepExecutionWorkerClient>;
  createRunTracker(): StepExecutionRunTracker;
  runtimeEnvironmentOrchestrator: StepExecutionRuntimeEnvironmentOrchestrator;
  agentRunner: StepExecutionAgentRunner;
  /** Override the artifact store (defaults to LocalArtifactStore under ~/.boboddy/artifacts). */
  artifactStore?: ArtifactStore | undefined;
  sleep(milliseconds: number): Promise<void>;
  logger: ProjectWorkLogger;
  reporter?: WorkReporter | undefined;
};

function loadDefaultDeps(
  dest?: DestinationStream,
  localEnvVars?: Record<string, string>,
  reporter?: WorkReporter,
): ProcessProjectWorkDeps {
  const logger = createLogger(
    { name: "@boboddy/worker", level: process.env["BOBODDY_LOG_LEVEL"] ?? "info" },
    dest,
  );
  const workLogger = logger.child({ scope: "work" });
  return {
    createWorkerClient: createStepExecutionPlaneWorkerClient,
    createRunTracker: () => new SqliteLocalRuntimeSessionStore(),
    runtimeEnvironmentOrchestrator:
      new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
        logger.child({ scope: "runtime-environment-orchestrator" }),
        localEnvVars,
      ),
    agentRunner: new DefaultOpencodeStepRunner(),
    sleep: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    logger: {
      debug: (scope, message, details) => {
        workLogger.debug({ ...details, workScope: scope }, message);
      },
      log: (scope, message, details) => {
        workLogger.info({ ...details, workScope: scope }, message);
      },
      error: (scope, message, details) => {
        workLogger.error({ ...details, workScope: scope }, message);
      },
    },
    reporter,
  };
}

function parsePositiveInt(
  value: string | number | undefined,
  fallback: number,
): number {
  const parsedValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return fallback;
  }

  return parsedValue;
}

function resolveConcurrency(value?: number): number {
  return parsePositiveInt(
    value ?? process.env["BOBODDY_WORK_CONCURRENCY"],
    DEFAULT_WORK_CONCURRENCY,
  );
}

function resolvePollIntervalMs(value?: number): number {
  return parsePositiveInt(
    value ?? process.env["BOBODDY_WORK_POLL_INTERVAL_MS"],
    DEFAULT_POLL_INTERVAL_MS,
  );
}

function resolveLeaseDurationSeconds(value?: number): number {
  return parsePositiveInt(
    value ?? process.env["BOBODDY_WORK_LEASE_DURATION_SECONDS"],
    DEFAULT_LEASE_DURATION_SECONDS,
  );
}

function resolveWorkerId(projectId: string, workerId?: string) {
  const normalizedWorkerId = workerId?.trim();

  if (normalizedWorkerId) {
    return normalizedWorkerId;
  }

  return `boboddy-work-${hostname()}-${String(process.pid)}-${projectId}`;
}

export async function runProjectWork(
  options: ProcessProjectWorkOptions,
  deps?: ProcessProjectWorkDeps,
): Promise<ProcessProjectWorkResult> {
  const resolvedDeps =
    deps ?? loadDefaultDeps(options.dest, options.localEnvVars, options.reporter);
  const projectId = parseUuidV7(options.projectId);
  const baseUrl = resolveBoboddyBaseUrl(options.baseUrl);
  const workerClient = await resolvedDeps.createWorkerClient(baseUrl);
  const concurrency = resolveConcurrency(options.concurrency);
  const pollIntervalMs = resolvePollIntervalMs(options.pollIntervalMs);
  const leaseDurationSeconds = resolveLeaseDurationSeconds(
    options.leaseDurationSeconds,
  );
  const batchSize = parsePositiveInt(options.batchSize, concurrency);
  const workerId = resolveWorkerId(projectId, options.workerId);

  const artifactStore =
    resolvedDeps.artifactStore ??
    new LocalArtifactStore(path.join(os.homedir(), ".boboddy", "artifacts"));

  return await processProjectWorkInCore(
    {
      projectId,
      workerId,
      batchSize,
      concurrency,
      pollIntervalMs,
      leaseDurationSeconds,
      workItemId: options.workItemId,
      preserveRuntimeOnComplete: options.preserveRuntimeOnComplete,
      once: options.once,
      sessionStartTimeoutMs: options.sessionStartTimeoutMs,
    },
    {
      workerClient,
      createRunTracker: () => resolvedDeps.createRunTracker(),
      runtimeEnvironmentOrchestrator:
        resolvedDeps.runtimeEnvironmentOrchestrator,
      agentRunner: resolvedDeps.agentRunner,
      artifactStore,
      sleep: (milliseconds) => resolvedDeps.sleep(milliseconds),
      logger: {
        debug: (scope, message, details) => {
          resolvedDeps.logger.debug(scope, message, details);
        },
        log: (scope, message, details) => {
          resolvedDeps.logger.log(scope, message, details);
        },
        error: (scope, message, details) => {
          resolvedDeps.logger.error(scope, message, details);
        },
      },
      reporter: resolvedDeps.reporter,
    },
  );
}

export const processProjectWork = runProjectWork;

export type { ProcessProjectWorkResult };
export type { LocalRuntimeSessionStore };
