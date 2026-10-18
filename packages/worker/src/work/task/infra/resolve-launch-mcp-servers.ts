import type {
  OpenCodeMcpServers,
  ResolvedOpenCodeMcpServers,
} from "../../../common/contracts/opencode-mcp";
import { discoverRepoAgentTools } from "../../../project/agent-tools/infra/discover-repo-agent-tools";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../application/resolve-step-env";
import { logWork } from "../application/work-logger";
import { resolveStepMcpServers } from "./mcp-server-ref-resolver";

/** A step's MCP servers with every ref resolved, plus what env resolution needs from each ref. */
export type StepMcpServerPlan = {
  servers: ResolvedOpenCodeMcpServers | null;
  refs: McpEnvRef[];
};

/**
 * Builds a launch's MCP servers from the step's entries and the servers
 * discovered in `workspacePath` (the host-side checkout): refs resolved,
 * every other discovered server disabled. Returns each ref's `requiredEnv`
 * for env resolution (D3). Logs each resolved
 * ref by key, source and type, plus the disabled and skipped server names —
 * never a definition, which can carry secrets.
 *
 * Throws `McpServerRefNotFoundError`, which the caller lets propagate so the
 * launch fails before anything starts.
 */
export async function planStepMcpServers(input: {
  servers: OpenCodeMcpServers | null | undefined;
  workspacePath: string;
  sessionId: string;
}): Promise<StepMcpServerPlan> {
  const tools = await discoverRepoAgentTools(input.workspacePath);
  const { servers, resolvedRefs, disabledServers } = resolveStepMcpServers({
    servers: input.servers,
    tools,
  });
  for (const ref of resolvedRefs) {
    logWork("runtime", "Resolved MCP server ref", {
      sessionId: input.sessionId,
      key: ref.key,
      lookupName: ref.lookupName,
      source: ref.source,
      type: ref.type,
      inlineSecretsRemoved: ref.inlineSecrets.map(
        ({ field, key }) => `${field}.${key}`,
      ),
    });
  }
  if (disabledServers.length > 0 || tools.skipped.length > 0) {
    logWork("runtime", "Repository MCP servers not used by this step", {
      sessionId: input.sessionId,
      disabled: disabledServers,
      skipped: tools.skipped
        .filter((entry) => entry.kind === "server")
        .map(({ source, name, reason }) => ({ source, name, reason })),
    });
  }
  return {
    servers,
    refs: resolvedRefs.map(({ key, requiredEnv }) => ({ key, requiredEnv })),
  };
}

export type StepMcpLaunch = {
  servers: ResolvedOpenCodeMcpServers | null;
  stepEnv: Readonly<Record<string, string>> | undefined;
  /** Secret values of variables inferred from the refs, for the log masker. */
  secretValues: string[];
};

/**
 * Resolves the step env again with each ref's inferred variables when the
 * step names refs (`resolveMcpEnv` is set). Without `resolveMcpEnv` the
 * caller's `stepEnv` passes through untouched. Throws `MissingStepEnvError`
 * for any missing required variable.
 */
export function applyStepMcpEnv(input: {
  plan: StepMcpServerPlan;
  stepEnv: Readonly<Record<string, string>> | undefined;
  resolveMcpEnv: ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
}): StepMcpLaunch {
  if (input.resolveMcpEnv === undefined) {
    return {
      servers: input.plan.servers,
      stepEnv: input.stepEnv,
      secretValues: [],
    };
  }
  const resolved = input.resolveMcpEnv(input.plan.refs);
  return {
    servers: input.plan.servers,
    stepEnv: resolved.stepEnv,
    secretValues: resolved.secretValues,
  };
}
