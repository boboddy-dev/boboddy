import type { DestinationStream } from "pino";
import { createBoboddyClient } from "@boboddy/sdk";
import type { RepoConfig } from "@boboddy/sdk/repo-config";
import { createLogger } from "@boboddy/observability/logging/host";
import { createUuidV7, parseUuidV7 } from "../../../common/contracts/uuid-v7";
import { ConfigurationError } from "../../../lib/errors";
import { resolveBoboddyBaseUrl } from "../../../auth/session/infra/auth-config";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import { DirectProviderAccessResolver } from "../infra/provider-access/direct-provider-access-resolver";
import { SafeProviderAccessResolver } from "../infra/provider-access/safe-provider-access-resolver";
import { buildFakeAiProviderOverride, FakeAiServer } from "../infra/fake-ai";
import type { TaskRuntimeEnvironmentOrchestrator } from "../contracts/process-project-work-types";
import {
  buildDryRunNoWorkspaceOrchestrator,
  buildDryRunWorkspaceOrchestrator,
} from "./run-work-dry-run-orchestrators";
import {
  runInDryRunEnvironment,
  type DryRunEnvironmentHealth,
} from "./dry-run-environment";
import { runHealthChecks, type HealthCheckReport } from "./run-health-checks";
import { planStepEnv } from "./resolve-step-env";
import {
  buildAuthHeaders,
  fetchProjectGitUrl,
  fetchStepDefinition,
} from "./run-work-dry-run";
import {
  describeHealthCheckRuntime,
  planHealthCheckLaunches,
  type HealthCheckStep,
  type PlannedHealthCheckLaunch,
} from "./plan-pipeline-health-check-launches";
import {
  computePipelineHealthGateOk,
  type StepHealthCheckReport,
} from "./pipeline-health-check-report";
import { logWork, logWorkError } from "./work-logger";

/**
 * The post-push run-offer gate's dry run: every step of a pushed pipeline has
 * its declared health checks run, in one launch per distinct runtime (see
 * `plan-pipeline-health-check-launches.ts`), and the result is reported per
 * step (see `pipeline-health-check-report.ts`).
 *
 * Each step's checks run as their own `runHealthChecks` call on the shared
 * launch, so a `required` failure aborts only the rest of that step's checks,
 * never another step's. Launches run one after another, each torn down before
 * the next starts, so a pipeline never has two containers up at once.
 */

export type PipelineHealthDryRunReport = {
  /** See `computePipelineHealthGateOk`: false only for blocking findings. */
  ok: boolean;
  pipelineDefinitionId: string;
  /** How many environments were launched. */
  launchCount: number;
  /** Steps that declare checks, in pipeline order. */
  steps: StepHealthCheckReport[];
  /** Steps that declare none (code steps always), so nothing ran for them. */
  stepsWithoutChecks: Array<{ stepKey: string; stepName: string }>;
};

/** What running one planned launch produced. */
export type HealthCheckLaunchOutcome =
  | { kind: "launch-failed"; reason: string }
  | {
      kind: "ran";
      health: DryRunEnvironmentHealth;
      /** Keyed by `stepDefinitionId`. */
      healthChecksByStep: ReadonlyMap<string, HealthCheckReport[]>;
    };

export type RunHealthCheckLaunch = (
  launch: PlannedHealthCheckLaunch,
) => Promise<HealthCheckLaunchOutcome>;

function environmentProblems(health: DryRunEnvironmentHealth): string[] {
  const problems: string[] = [];
  if (health.containerHealth && !health.containerHealth.healthy) {
    problems.push(`container ${health.containerHealth.status}`);
  }
  if (!health.opencodeHealth.healthy) {
    problems.push(
      `OpenCode unhealthy${health.opencodeHealth.detail ? ` (${health.opencodeHealth.detail})` : ""}`,
    );
  }
  return problems;
}

function toStepReport(
  step: HealthCheckStep,
  runtime: string,
  outcome: HealthCheckLaunchOutcome,
): StepHealthCheckReport {
  const base = {
    stepDefinitionId: step.stepDefinitionId,
    stepKey: step.key,
    stepName: step.name,
    runtime,
  };
  if (outcome.kind === "launch-failed") {
    return {
      ...base,
      launchError: outcome.reason,
      environmentProblems: [],
      mcpServers: [],
      healthChecks: [],
    };
  }
  const declared = new Set(Object.keys(step.opencodeMcpJson ?? {}));
  return {
    ...base,
    launchError: null,
    environmentProblems: environmentProblems(outcome.health),
    mcpServers: outcome.health.mcpServers.filter((server) =>
      declared.has(server.name),
    ),
    healthChecks: outcome.healthChecksByStep.get(step.stepDefinitionId) ?? [],
  };
}

/**
 * Plan the launches for `steps` (in pipeline order), run each through
 * `runLaunch` in turn, and report per step. The I/O-free core of
 * {@link runPipelineHealthChecksDryRun}: `runLaunch` is the seam.
 */
export async function runPipelineHealthCheckLaunches(input: {
  pipelineDefinitionId: string;
  steps: readonly HealthCheckStep[];
  runLaunch: RunHealthCheckLaunch;
}): Promise<PipelineHealthDryRunReport> {
  const plan = planHealthCheckLaunches(input.steps);
  const reportByStep = new Map<string, StepHealthCheckReport>();

  for (const launch of plan.launches) {
    // A launch that throws after coming up (a probe or runner error) is
    // still torn down by `runInDryRunEnvironment`; here it only costs its
    // own steps, not the launches after it.
    let outcome: HealthCheckLaunchOutcome;
    try {
      outcome = await input.runLaunch(launch);
    } catch (error) {
      outcome = { kind: "launch-failed", reason: errorMessage(error) };
    }
    const runtime = describeHealthCheckRuntime(launch.runtime);
    for (const step of launch.steps) {
      reportByStep.set(
        step.stepDefinitionId,
        toStepReport(step, runtime, outcome),
      );
    }
  }

  const steps = input.steps.flatMap((step) => {
    const report = reportByStep.get(step.stepDefinitionId);
    return report ? [report] : [];
  });
  return {
    ok: computePipelineHealthGateOk(steps),
    pipelineDefinitionId: input.pipelineDefinitionId,
    launchCount: plan.launches.length,
    steps,
    stepsWithoutChecks: plan.stepsWithoutChecks.map((step) => ({
      stepKey: step.key,
      stepName: step.name,
    })),
  };
}

const WORKING_NODE_KINDS = new Set(["step", "fanOut", "loop"]);

type PipelineNodeForHealthChecks = {
  kind: string;
  stepDefinitionId: string;
  position: number;
};

/**
 * The distinct step definitions a pipeline runs, in position order. Only
 * working nodes reference one; a `choice`/`fail`/`succeed` node's
 * `stepDefinitionId` is its own node id.
 */
export function listPipelineStepDefinitionIds(
  nodes: readonly PipelineNodeForHealthChecks[],
): string[] {
  const ordered = [...nodes]
    .filter((node) => WORKING_NODE_KINDS.has(node.kind))
    .sort((left, right) => left.position - right.position);
  return [...new Set(ordered.map((node) => node.stepDefinitionId))];
}

export type PipelineHealthChecksDryRunOptions = {
  projectId: string;
  pipelineDefinitionId: string;
  baseUrl?: string | undefined;
  dest?: DestinationStream | undefined;
  /** Env vars read from `.boboddy/.env` in the user's local project directory. */
  localEnvVars?: Record<string, string> | undefined;
  /** See `WorkDryRunOptions.sourceBranch`. */
  sourceBranch?: string | null | undefined;
};

/** A dry run has no step key, so it never commits: read-only, or no clone on the host. */
const repoForLaunch = (launch: PlannedHealthCheckLaunch): RepoConfig =>
  launch.runtime.kind === "host" ? { mode: "none" } : { mode: "readOnly" };

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch `pipelineDefinitionId`'s steps and run every one's health checks, one
 * launch per distinct runtime. Never throws for an unhealthy environment or a
 * failing check — those are in the report — only for an unreadable pipeline.
 */
export async function runPipelineHealthChecksDryRun(
  options: PipelineHealthChecksDryRunOptions,
): Promise<PipelineHealthDryRunReport> {
  const baseUrl = resolveBoboddyBaseUrl(options.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new ConfigurationError(`Not signed in to ${baseUrl}.`);
  }
  const headers = buildAuthHeaders(authenticated.profile.accessToken);
  const requestedByUserId = parseUuidV7(authenticated.session.user.id);
  const projectId = parseUuidV7(options.projectId);
  const client = createBoboddyClient(baseUrl);

  const pipeline = await client.pipelineDefinitions.getPipelineDefinition({
    path: { pipelineDefinitionId: options.pipelineDefinitionId },
    headers,
  });
  const nodes = (
    pipeline.data as
      { stepDefinitions: PipelineNodeForHealthChecks[] } | undefined
  )?.stepDefinitions;
  if (!nodes) {
    throw new ConfigurationError(
      `Pipeline definition ${options.pipelineDefinitionId} was not found.`,
    );
  }
  const stepDefinitions = await Promise.all(
    listPipelineStepDefinitionIds(nodes).map((id) =>
      fetchStepDefinition(client, headers, id),
    ),
  );
  const steps: HealthCheckStep[] = stepDefinitions.map((step) => ({
    stepDefinitionId: step.id,
    key: step.key,
    name: step.name,
    executionMode: step.executionMode,
    devcontainerConfigPath: step.devcontainerConfigPath,
    managedRuntime: step.managedRuntime,
    opencodeMcpJson: step.opencodeMcpJson,
    healthChecksJson: step.healthChecksJson,
    envJson: step.envJson,
  }));

  const logger = createLogger(
    {
      name: "@boboddy/worker",
      level: process.env["BOBODDY_LOG_LEVEL"] ?? "info",
    },
    options.dest,
  ).child({ scope: "pipeline-health-dry-run" });
  const providerAccessResolver = new SafeProviderAccessResolver(
    new DirectProviderAccessResolver({ logger }),
  );
  const localEnvVars = options.localEnvVars ?? {};
  let workspaceOrchestrator: TaskRuntimeEnvironmentOrchestrator | undefined;
  let hostOrchestrator: TaskRuntimeEnvironmentOrchestrator | undefined;
  const orchestratorFor = (isHost: boolean) =>
    isHost
      ? (hostOrchestrator ??= buildDryRunNoWorkspaceOrchestrator(
          logger,
          providerAccessResolver,
        ))
      : (workspaceOrchestrator ??= buildDryRunWorkspaceOrchestrator(
          logger,
          localEnvVars,
          providerAccessResolver,
        ));

  const gitUrl = await fetchProjectGitUrl(client, headers, options.projectId);

  // One fake provider for every launch: it has to be baked into each agent's
  // launch-time config before any forced tool call can run.
  const fakeAiServer = new FakeAiServer();
  await fakeAiServer.start();

  const runLaunch: RunHealthCheckLaunch = async (launch) => {
    const isHost = launch.runtime.kind === "host";
    const runtime = describeHealthCheckRuntime(launch.runtime);
    let stepEnvPlan: ReturnType<typeof planStepEnv>;
    try {
      stepEnvPlan = planStepEnv({
        envJson: launch.envJson,
        inputJson: null,
        workerEnv: { ...process.env, ...localEnvVars },
        opencodeMcpJson: launch.opencodeMcpJson,
      });
    } catch (error) {
      return { kind: "launch-failed", reason: errorMessage(error) };
    }
    const taskId = createUuidV7();
    logWork("dry-run", "Launching for pipeline health checks", {
      pipelineDefinitionId: options.pipelineDefinitionId,
      runtime,
      steps: launch.steps.map((step) => step.key),
    });
    const outcome = await runInDryRunEnvironment({
      orchestrator: orchestratorFor(isHost),
      keep: false,
      launchInput: {
        startAgent: true,
        sessionId: taskId,
        projectId,
        requestedByUserId,
        gitUrl,
        baseWorkBranch: null,
        sourceBranch: options.sourceBranch ?? null,
        stepKey: undefined,
        opencodeMcpJson: launch.opencodeMcpJson,
        currentExecutionInfo: { taskId, resultSchemaJson: null },
        taskId,
        fakeAiProviderOverride: buildFakeAiProviderOverride({
          fakeAiServer,
          isNoWorkspace: isHost,
        }),
        stepEnv: stepEnvPlan.resolved.stepEnv,
        setupEnv: stepEnvPlan.resolved.setupEnv,
        resolveMcpEnv: stepEnvPlan.resolveMcpEnv,
        devcontainerConfigPath:
          launch.runtime.kind === "devcontainer"
            ? launch.runtime.devcontainerConfigPath
            : null,
        managedRuntime:
          launch.runtime.kind === "managed"
            ? launch.runtime.managedRuntime
            : null,
        repo: repoForLaunch(launch),
      },
      run: async (server) => {
        const healthChecksByStep = new Map<string, HealthCheckReport[]>();
        for (const step of launch.steps) {
          healthChecksByStep.set(
            step.stepDefinitionId,
            await runHealthChecks({
              server,
              healthChecks: step.healthChecksJson ?? [],
              fakeAiServer,
            }),
          );
        }
        return healthChecksByStep;
      },
    });
    if (outcome.kind === "launch-failed") {
      logWorkError("dry-run", "Pipeline health-check launch failed", {
        pipelineDefinitionId: options.pipelineDefinitionId,
        runtime,
        error: outcome.reason,
      });
      return outcome;
    }
    return {
      kind: "ran",
      health: outcome.health,
      healthChecksByStep: outcome.result,
    };
  };

  try {
    return await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: options.pipelineDefinitionId,
      steps,
      runLaunch,
    });
  } finally {
    // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
    await fakeAiServer.stop().catch((error: unknown) => {
      logWorkError("dry-run", "Failed to stop the shared fake AI server", {
        error: errorMessage(error),
      });
    });
  }
}
