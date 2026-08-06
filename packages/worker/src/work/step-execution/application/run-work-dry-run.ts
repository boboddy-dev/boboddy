import type { DestinationStream } from "pino";
import { createBoboddyClient } from "@boboddy/sdk";
import { createUuidV7, parseUuidV7 } from "../../../common/contracts/uuid-v7";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { OpenCodePlugins } from "../../../common/contracts/opencode-plugin";
import { ConfigurationError } from "../../../lib/errors";
import { createLogger } from "../../../lib/logger";
import { resolveBoboddyBaseUrl } from "../../../auth/session/infra/auth-config";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import { DirectProviderAccessResolver } from "../infra/provider-access/direct-provider-access-resolver";
import { SafeProviderAccessResolver } from "../infra/provider-access/safe-provider-access-resolver";
import { logWork, logWorkError } from "./work-logger";
import { noopReporter, type WorkReporter } from "../contracts/work-reporter";
import { FakeAiServer, resolveFakeAiHost } from "../infra/fake-ai";
import {
  buildDryRunNoWorkspaceOrchestrator,
  buildDryRunWorkspaceOrchestrator,
} from "./run-work-dry-run-orchestrators";
import {
  checkOpencodeHealth,
  pollMcpStatus,
} from "./run-work-dry-run-health-checks";
import {
  computeDryRunOk,
  runMcpCanaries,
  type WorkDryRunMcpServerReport,
} from "./run-work-dry-run-mcp-canaries";

export type { WorkDryRunMcpServerReport };
export type { McpCanaryOutcome } from "./run-work-dry-run-mcp-canaries";

export type WorkDryRunScope =
  | {
      kind: "step";
      stepDefinitionId: string;
      stepDefinitionKey: string;
      stepDefinitionName: string;
      executionMode: "workspace" | "no_workspace";
    }
  | { kind: "global-only" };

export type WorkDryRunReport = {
  /** See {@link computeDryRunOk} — health, handshakes, and canary outcomes combined. */
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
  mcpServers: WorkDryRunMcpServerReport[];
  /** Set only when the environment failed to launch at all (no health data below applies). */
  launchError?: string | undefined;
};

export type WorkDryRunOptions = {
  projectId: string;
  baseUrl?: string | undefined;
  /** Fetch this step definition's real `opencodeMcpJson`/`opencodePluginJson`. */
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
};

type StepDefinitionForDryRun = {
  id: string;
  key: string;
  name: string;
  executionMode: "workspace" | "no_workspace";
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: OpenCodeMcpServers | null;
  opencodePluginJson: OpenCodePlugins | null;
};

function buildAuthHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function fetchProjectGitUrl(
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

async function fetchStepDefinition(
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
        resultSchemaJson: Record<string, unknown> | null;
        opencodeMcpJson: OpenCodeMcpServers | null;
        opencodePluginJson: OpenCodePlugins | null;
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
    resultSchemaJson: data.resultSchemaJson,
    opencodeMcpJson: data.opencodeMcpJson,
    opencodePluginJson: data.opencodePluginJson,
  };
}

/**
 * Environment-only rehearsal of the production launch path, for `work
 * --dry-run`: brings up the exact same devcontainer + in-container OpenCode
 * process a real step execution would (with that step's real MCP servers
 * injected, when scoped to one), then reports container health, OpenCode
 * health, provider-credential status, and per-MCP-server health — without
 * claiming a step execution, sending any prompt, or producing findings.
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
      }
    : { kind: "global-only" };

  const reporter = options.reporter ?? noopReporter;
  const logger = createLogger(
    { name: "@boboddy/worker", level: process.env["BOBODDY_LOG_LEVEL"] ?? "info" },
    options.dest,
  ).child({ scope: "work-dry-run" });

  const sessionId = createUuidV7();
  // Synthetic — never sent to the server. Used only to correlate reporter
  // events and to satisfy the launch contract's `currentExecutionInfo`.
  const stepExecutionId = sessionId;

  const safeProviderAccessResolver = new SafeProviderAccessResolver(
    new DirectProviderAccessResolver({ logger }),
  );
  const isNoWorkspace = scope.kind === "step" && scope.executionMode === "no_workspace";
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
  reporter.event({ type: "step:starting", stepExecutionId });

  // Started unconditionally (rather than only once a canary-worthy server is
  // found) because the fake provider must be baked into the agent's
  // launch-time config, before this dry run knows which of its MCP servers
  // (if any) the canary registry will match. Shared across every canary run
  // below and stopped once, regardless of outcome.
  const fakeAiServer = new FakeAiServer();
  await fakeAiServer.start();

  try {
    let environment: Awaited<ReturnType<typeof orchestrator.launch>>;
    try {
      environment = await orchestrator.launch({
        sessionId,
        projectId,
        requestedByUserId,
        gitUrl,
        baseWorkBranch: null,
        // No stepKey: skips work-branch creation, so a dry run never pushes or
        // even creates a `boboddy/...` branch.
        stepKey: undefined,
        opencodeMcpJson: stepDefinition?.opencodeMcpJson ?? null,
        opencodePluginJson: stepDefinition?.opencodePluginJson ?? null,
        currentExecutionInfo: {
          stepExecutionId,
          resultSchemaJson: stepDefinition?.resultSchemaJson ?? null,
        },
        reporter,
        stepExecutionId,
        // `no_workspace` runs the agent directly on the host, alongside this
        // fake-LLM server — reachable via loopback. `workspace` runs it inside
        // a devcontainer, which needs the Docker host-gateway alias instead.
        fakeAiProviderOverride: {
          baseUrl: `http://${isNoWorkspace ? "127.0.0.1" : resolveFakeAiHost()}:${String(fakeAiServer.port)}`,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logWorkError("dry-run", "Dry run environment failed to launch", {
        projectId: options.projectId,
        scope,
        error: reason,
      });
      reporter.event({ type: "step:failed", stepExecutionId, reason });
      return {
        ok: false,
        scope,
        workspacePath: null,
        runtimeContainerId: null,
        agentBaseUrl: null,
        kept: false,
        containerHealth: null,
        opencodeHealth: null,
        providerCredentials: safeProviderAccessResolver.lastError
          ? { ok: false, detail: safeProviderAccessResolver.lastError.message }
          : { ok: true, detail: "resolved" },
        mcpServers: [],
        launchError: reason,
      };
    }

    reporter.event({ type: "step:runtime-ready", stepExecutionId });

    const containerHealth =
      environment.runtimeContainerId && environment.checkContainerHealth
        ? await environment.checkContainerHealth().then((result) => ({
            status: result.runtimeContainerStatus,
            healthy: ["healthy", "running"].includes(
              result.runtimeContainerStatus,
            ),
          }))
        : null;
    const opencodeHealth = await checkOpencodeHealth(environment.agentBaseUrl);
    const providerCredentials = safeProviderAccessResolver.lastError
      ? { ok: false, detail: safeProviderAccessResolver.lastError.message }
      : { ok: true, detail: "resolved" };
    const handshakeReports = await pollMcpStatus(
      environment.agentBaseUrl,
      environment.workspaceFolder,
    );
    const mcpServers = await runMcpCanaries({
      agentBaseUrl: environment.agentBaseUrl,
      workspaceFolder: environment.workspaceFolder,
      mcpServers: handshakeReports,
      fakeAiServer,
    });

    const ok = computeDryRunOk({
      containerHealthy: containerHealth?.healthy,
      opencodeHealthy: opencodeHealth.healthy,
      mcpServers,
    });

    reporter.event(
      ok
        ? { type: "step:succeeded", stepExecutionId }
        : {
            type: "step:failed",
            stepExecutionId,
            reason: "One or more health checks failed — see the report above.",
          },
    );

    const keep = options.keep ?? false;
    if (!keep) {
      await environment.cleanup();
      logWork("dry-run", "Dry run environment cleaned up", {
        projectId: options.projectId,
        runtimeContainerId: environment.runtimeContainerId,
      });
    } else {
      logWork("dry-run", "Dry run environment preserved (--keep)", {
        projectId: options.projectId,
        workspacePath: environment.workspacePath,
        runtimeContainerId: environment.runtimeContainerId,
        agentBaseUrl: environment.agentBaseUrl,
      });
    }

    return {
      ok,
      scope,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: environment.agentBaseUrl,
      kept: keep,
      containerHealth: containerHealth ?? null,
      opencodeHealth,
      providerCredentials,
      mcpServers,
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
  return [...latestByKey.values()].map(({ id, key, name }) => ({ id, key, name }));
}
