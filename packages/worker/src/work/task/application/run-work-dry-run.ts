import type { DestinationStream } from "pino";
import { createBoboddyClient } from "@boboddy/sdk";
import type { EnvVarSpec } from "@boboddy/sdk/env-vars";
import type { HealthCheck } from "@boboddy/sdk/health-checks";
import type { RepoConfig } from "@boboddy/sdk/repo-config";
import { createUuidV7, parseUuidV7 } from "../../../common/contracts/uuid-v7";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import { ConfigurationError } from "../../../lib/errors";
import { createLogger } from "@boboddy/observability/logging/host";
import { resolveBoboddyBaseUrl } from "../../../auth/session/infra/auth-config";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import { DirectProviderAccessResolver } from "../infra/provider-access/direct-provider-access-resolver";
import { SafeProviderAccessResolver } from "../infra/provider-access/safe-provider-access-resolver";
import { logWork, logWorkError } from "./work-logger";
import { noopReporter, type WorkReporter } from "../contracts/work-reporter";
import { buildFakeAiProviderOverride, FakeAiServer } from "../infra/fake-ai";
import {
  buildDryRunNoWorkspaceOrchestrator,
  buildDryRunWorkspaceOrchestrator,
} from "./run-work-dry-run-orchestrators";
import type { McpHandshakeReport } from "./run-work-dry-run-health-checks";
import { runInDryRunEnvironment } from "./dry-run-environment";
import { runHealthChecks, type HealthCheckReport } from "./run-health-checks";
import { computeDryRunOk } from "./compute-dry-run-ok";
import { planStepEnv } from "./resolve-step-env";

export type { McpHandshakeReport } from "./run-work-dry-run-health-checks";
export type {
  HealthCheckOutcome,
  HealthCheckReport,
} from "./run-health-checks";

export type WorkDryRunScope =
  | {
      kind: "step";
      stepDefinitionId: string;
      stepDefinitionKey: string;
      stepDefinitionName: string;
      executionMode: "workspace" | "no_workspace";
      devcontainerConfigPath: string | null;
    }
  | { kind: "global-only" };

export type WorkDryRunReport = {
  /** See {@link computeDryRunOk} — health, handshakes, and health check outcomes combined. */
  ok: boolean;
  scope: WorkDryRunScope;
  workspacePath: string | null;
  runtimeContainerId: string | null;
  agentBaseUrl: string | null;
  /** True when `--keep` preserved the container/workspace instead of tearing it down. */
  kept: boolean;
  containerHealth: { status: string; healthy: boolean } | null;
  opencodeHealth: { healthy: boolean; detail?: string | undefined } | null;
  providerCredentials: { ok: boolean; detail: string };
  /** Handshake status only — whether each server's declared health checks (if any) passed lives in {@link WorkDryRunReport.healthChecks}. */
  mcpServers: McpHandshakeReport[];
  /**
   * The step's declared health checks (#121), run via the shared runner
   * (`runHealthChecks`, #119) and reported flat — a check on a plugin or
   * standalone tool has no MCP server to nest under, so this is a top-level
   * array covering every declared check regardless of source. Empty when the
   * step declares none; there is no fallback verification in that case.
   */
  healthChecks: HealthCheckReport[];
  /** Set only when the environment failed to launch at all (no health data below applies). */
  launchError?: string | undefined;
};

export type WorkDryRunOptions = {
  projectId: string;
  baseUrl?: string | undefined;
  /** Fetch this step definition's real `opencodeMcpJson`. */
  stepDefinitionId?: string | undefined;
  /**
   * Skip step-specific MCP injection; test whatever MCP servers are already
   * configured (e.g. the user's synced global `opencode.json`). Callers should
   * set this when the project has no step definitions yet, or the user opted
   * out of picking one.
   */
  globalOnly?: boolean | undefined;
  /** Preserve the container/workspace after the report instead of tearing down. */
  keep?: boolean | undefined;
  dest?: DestinationStream | undefined;
  /** Env vars read from .boboddy/.env in the user's local project directory. */
  localEnvVars?: Record<string, string> | undefined;
  reporter?: WorkReporter | undefined;
  /**
   * The CLI's resolved/overridden current local branch at invocation (see
   * `resolveSourceBranch`). A dry run has no step key (no work branch is
   * created), but this branch is still checked out after clone so the
   * rehearsed devcontainer config matches what a real run would use.
   */
  sourceBranch?: string | null | undefined;
};

export type StepDefinitionForDryRun = {
  id: string;
  key: string;
  name: string;
  executionMode: "workspace" | "no_workspace";
  devcontainerConfigPath: string | null;
  managedRuntime: string | null;
  repo: RepoConfig;
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: OpenCodeMcpServers | null;
  healthChecksJson: HealthCheck[] | null;
  envJson: EnvVarSpec[] | null;
};

/** A global-only dry run has no step, so it commits nothing: read-only. */
const DRY_RUN_GLOBAL_REPO: RepoConfig = { mode: "readOnly" };

export function buildAuthHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function fetchProjectGitUrl(
  client: ReturnType<typeof createBoboddyClient>,
  headers: { Authorization: string },
  projectId: string,
): Promise<string> {
  const result = await client.projects.getProject({
    path: { projectId },
    headers,
  });
  const gitUrl = (result.data as { gitUrl?: string } | undefined)?.gitUrl;
  if (!gitUrl) {
    throw new ConfigurationError(
      `Could not resolve the git URL for project ${projectId}.`,
    );
  }
  return gitUrl;
}

export async function fetchStepDefinition(
  client: ReturnType<typeof createBoboddyClient>,
  headers: { Authorization: string },
  stepDefinitionId: string,
): Promise<StepDefinitionForDryRun> {
  const result = await client.stepDefinitions.getStepDefinition({
    path: { stepDefinitionId },
    headers,
  });
  const data = result.data as
    | {
        id: string;
        key: string;
        name: string;
        executionMode?: "workspace" | "no_workspace";
        devcontainerConfigPath?: string | null;
        managedRuntime?: string | null;
        repo: RepoConfig;
        resultSchemaJson: Record<string, unknown> | null;
        opencodeMcpJson: OpenCodeMcpServers | null;
        healthChecksJson: HealthCheck[] | null;
        envJson: EnvVarSpec[] | null;
      }
    | undefined;
  if (!data) {
    throw new ConfigurationError(
      `Step definition ${stepDefinitionId} was not found.`,
    );
  }
  return {
    id: data.id,
    key: data.key,
    name: data.name,
    executionMode: data.executionMode ?? "workspace",
    devcontainerConfigPath: data.devcontainerConfigPath ?? null,
    managedRuntime: data.managedRuntime ?? null,
    repo: data.repo,
    resultSchemaJson: data.resultSchemaJson,
    opencodeMcpJson: data.opencodeMcpJson,
    healthChecksJson: data.healthChecksJson,
    envJson: data.envJson,
  };
}

/**
 * Environment-only rehearsal of the production launch path, for `work
 * --dry-run`: brings up the exact same devcontainer + in-container OpenCode
 * process a real task run would (with that step's real MCP servers
 * injected, when scoped to one), then reports container health, OpenCode
 * health, provider-credential status, and per-MCP-server health — without
 * claiming a task, sending any prompt, or producing findings.
 *
 * Missing provider credentials are reported as a line item rather than
 * aborting the run (see {@link SafeProviderAccessResolver}), since diagnosing
 * exactly that is a stated use case (onboarding, before credentials exist).
 */
export async function runWorkDryRun(
  options: WorkDryRunOptions,
): Promise<WorkDryRunReport> {
  if (!options.stepDefinitionId && !options.globalOnly) {
    throw new ConfigurationError(
      "runWorkDryRun requires either stepDefinitionId or globalOnly.",
    );
  }

  const baseUrl = resolveBoboddyBaseUrl(options.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new ConfigurationError(`Not signed in to ${baseUrl}.`);
  }
  const headers = buildAuthHeaders(authenticated.profile.accessToken);
  const requestedByUserId = parseUuidV7(authenticated.session.user.id);
  const projectId = parseUuidV7(options.projectId);

  const client = createBoboddyClient(baseUrl);
  const gitUrl = await fetchProjectGitUrl(client, headers, options.projectId);

  const stepDefinition = options.stepDefinitionId
    ? await fetchStepDefinition(client, headers, options.stepDefinitionId)
    : null;

  const scope: WorkDryRunScope = stepDefinition
    ? {
        kind: "step",
        stepDefinitionId: stepDefinition.id,
        stepDefinitionKey: stepDefinition.key,
        stepDefinitionName: stepDefinition.name,
        executionMode: stepDefinition.executionMode,
        devcontainerConfigPath: stepDefinition.devcontainerConfigPath,
      }
    : { kind: "global-only" };

  const reporter = options.reporter ?? noopReporter;
  const logger = createLogger(
    {
      name: "@boboddy/worker",
      level: process.env["BOBODDY_LOG_LEVEL"] ?? "info",
    },
    options.dest,
  ).child({ scope: "work-dry-run" });

  const sessionId = createUuidV7();
  // Synthetic — never sent to the server. Used only to correlate reporter
  // events and to satisfy the launch contract's `currentExecutionInfo`.
  const taskId = sessionId;

  const safeProviderAccessResolver = new SafeProviderAccessResolver(
    new DirectProviderAccessResolver({ logger }),
  );
  const isNoWorkspace =
    scope.kind === "step" && scope.executionMode === "no_workspace";
  const orchestrator = isNoWorkspace
    ? buildDryRunNoWorkspaceOrchestrator(logger, safeProviderAccessResolver)
    : buildDryRunWorkspaceOrchestrator(
        logger,
        options.localEnvVars ?? {},
        safeProviderAccessResolver,
      );

  logWork("dry-run", "Starting work dry run", {
    projectId: options.projectId,
    scope,
    keep: options.keep ?? false,
  });
  reporter.event({ type: "task:starting", taskId });

  // Started unconditionally (rather than only when the step declares
  // `healthChecks`) because the fake provider must be baked into the agent's
  // launch-time config, before any forced tool call can run. Shared across
  // every declared health check below and stopped once, regardless of
  // outcome.
  const fakeAiServer = new FakeAiServer();
  await fakeAiServer.start();

  const keep = options.keep ?? false;
  try {
    const { resolved, resolveMcpEnv } = planStepEnv({
      envJson: stepDefinition?.envJson ?? null,
      inputJson: null,
      workerEnv: { ...process.env, ...options.localEnvVars },
      opencodeMcpJson: stepDefinition?.opencodeMcpJson ?? null,
    });
    const outcome = await runInDryRunEnvironment({
      orchestrator,
      keep,
      launchInput: {
        startAgent: true,
        sessionId,
        projectId,
        requestedByUserId,
        gitUrl,
        baseWorkBranch: null,
        sourceBranch: options.sourceBranch ?? null,
        // No stepKey: skips work-branch creation, so a dry run never pushes or
        // even creates a `boboddy/...` branch.
        stepKey: undefined,
        opencodeMcpJson: stepDefinition?.opencodeMcpJson ?? null,
        currentExecutionInfo: {
          taskId,
          resultSchemaJson: stepDefinition?.resultSchemaJson ?? null,
        },
        reporter,
        taskId,
        fakeAiProviderOverride: buildFakeAiProviderOverride({
          fakeAiServer,
          isNoWorkspace,
        }),
        stepEnv: resolved.stepEnv,
        setupEnv: resolved.setupEnv,
        resolveMcpEnv,
        devcontainerConfigPath: stepDefinition?.devcontainerConfigPath ?? null,
        managedRuntime: stepDefinition?.managedRuntime ?? null,
        repo: stepDefinition?.repo ?? DRY_RUN_GLOBAL_REPO,
      },
      // Same runner the real-execution gate uses (`runHealthChecks`, #119),
      // with its declaration-order, abort-required-then-skip-the-rest
      // semantics and internal MCP warm-up unchanged. Dry run's different
      // policy (#121) sits above this call: a failing check never throws or
      // cuts the dry run short, and every check gets a reported outcome.
      onLaunched: () => {
        reporter.event({ type: "task:runtime-ready", taskId });
      },
      run: (server) =>
        runHealthChecks({
          server,
          healthChecks: stepDefinition?.healthChecksJson ?? [],
          fakeAiServer,
        }),
    });

    const providerCredentials = safeProviderAccessResolver.lastError
      ? { ok: false, detail: safeProviderAccessResolver.lastError.message }
      : { ok: true, detail: "resolved" };

    if (outcome.kind === "launch-failed") {
      const reason = outcome.reason;
      logWorkError("dry-run", "Dry run environment failed to launch", {
        projectId: options.projectId,
        scope,
        error: reason,
      });
      reporter.event({ type: "task:failed", taskId, reason });
      return {
        ok: false,
        scope,
        workspacePath: null,
        runtimeContainerId: null,
        agentBaseUrl: null,
        kept: false,
        containerHealth: null,
        opencodeHealth: null,
        providerCredentials,
        mcpServers: [],
        healthChecks: [],
        launchError: reason,
      };
    }

    const { health, result: healthChecks } = outcome;

    const ok = computeDryRunOk({
      containerHealthy: health.containerHealth?.healthy,
      opencodeHealthy: health.opencodeHealth.healthy,
      mcpServers: health.mcpServers,
      healthChecks,
    });

    reporter.event(
      ok
        ? { type: "task:succeeded", taskId }
        : {
            type: "task:failed",
            taskId,
            reason: "One or more health checks failed — see the report above.",
          },
    );

    logWork(
      "dry-run",
      keep
        ? "Dry run environment preserved (--keep)"
        : "Dry run environment cleaned up",
      {
        projectId: options.projectId,
        workspacePath: outcome.workspacePath,
        runtimeContainerId: outcome.runtimeContainerId,
        agentBaseUrl: outcome.agentBaseUrl,
      },
    );

    return {
      ok,
      scope,
      workspacePath: outcome.workspacePath,
      runtimeContainerId: outcome.runtimeContainerId,
      agentBaseUrl: outcome.agentBaseUrl,
      kept: keep,
      containerHealth: health.containerHealth,
      opencodeHealth: health.opencodeHealth,
      providerCredentials,
      mcpServers: health.mcpServers,
      healthChecks,
    };
  } finally {
    // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
    await fakeAiServer.stop().catch((error: unknown) => {
      logWorkError("dry-run", "Failed to stop the shared fake AI server", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export async function listProjectStepDefinitionsForDryRun(input: {
  projectId: string;
  baseUrl?: string | undefined;
}): Promise<Array<{ id: string; key: string; name: string }>> {
  const baseUrl = resolveBoboddyBaseUrl(input.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new ConfigurationError(`Not signed in to ${baseUrl}.`);
  }
  const headers = buildAuthHeaders(authenticated.profile.accessToken);
  const client = createBoboddyClient(baseUrl);
  const result = await client.stepDefinitions.listStepDefinitions({
    query: { projectId: input.projectId },
    headers,
  });
  const steps = (result.data ?? []) as Array<{
    id: string;
    key: string;
    name: string;
    version: number;
  }>;

  // Dedupe to the latest version per key, matching `pullPipelineDefinitions`'s
  // convention — the picker should offer one entry per step, not one per
  // historical version.
  const latestByKey = new Map<string, (typeof steps)[number]>();
  for (const step of steps) {
    const existing = latestByKey.get(step.key);
    if (!existing || step.version > existing.version) {
      latestByKey.set(step.key, step);
    }
  }
  return [...latestByKey.values()].map(({ id, key, name }) => ({
    id,
    key,
    name,
  }));
}
