import type {
  ResolvedOpenCodeMcpServerConfig,
  ResolvedOpenCodeMcpServers,
} from "@boboddy/sdk/opencode-mcp";
import type {
  OpenCodeOverlayAgent,
  OpenCodeOverlayConfig,
  OpenCodeOverlayMcpServer,
  OpenCodePermissionRule,
} from "./opencode-overlay-config";

const TASK_AGENT = "build";

/**
 * The permission action prefix of a server's MCP tools. OpenCode v2 names an
 * MCP tool `<server>_<tool>` and replaces characters outside `[A-Za-z0-9_-]`
 * with `_` (observed on 2.0.28: server `my-fix.v2` exposes `my-fix_v2_echo`).
 */
export function mcpToolActionPattern(serverName: string): string {
  return `${serverName.replace(/[^A-Za-z0-9_-]/gu, "_")}_*`;
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Step MCP servers are passed through in their native v2 shape. Code Mode is
 * off unless the step opts in: Code Mode hides MCP tools from the agent's
 * native tool list, and both the step prompt and the MCP health checks call
 * those tools directly by name.
 */
function toOverlayMcpServer(
  server: ResolvedOpenCodeMcpServerConfig,
): OpenCodeOverlayMcpServer {
  return { ...cloneConfig(server), codemode: server.codemode ?? false };
}

function mergeMcpConfig(
  baseMcp: OpenCodeOverlayConfig["mcp"],
  stepMcpServers: ResolvedOpenCodeMcpServers | null | undefined,
): OpenCodeOverlayConfig["mcp"] {
  if (!stepMcpServers || Object.keys(stepMcpServers).length === 0) {
    return baseMcp;
  }

  const servers = { ...(baseMcp?.servers ?? {}) };
  for (const [serverName, server] of Object.entries(stepMcpServers)) {
    servers[serverName] = toOverlayMcpServer(server);
  }
  return { ...baseMcp, servers };
}

/**
 * Step MCP tools are hidden from every agent by a global deny and re-allowed
 * on the task agent only. Rules are ordered and the last match wins;
 * agent rules are appended after global rules, so the agent allow overrides
 * the global deny for that agent alone.
 */
function mcpToolRules(
  stepMcpServers: ResolvedOpenCodeMcpServers | null | undefined,
  effect: OpenCodePermissionRule["effect"],
): OpenCodePermissionRule[] {
  return Object.keys(stepMcpServers ?? {}).map((serverName) => ({
    action: mcpToolActionPattern(serverName),
    resource: "*",
    effect,
  }));
}

function mergeAgentsConfig(
  baseAgents: OpenCodeOverlayConfig["agents"],
  stepMcpServers: ResolvedOpenCodeMcpServers | null | undefined,
  agentPromptText: string | null | undefined,
): OpenCodeOverlayConfig["agents"] {
  const allowRules = mcpToolRules(stepMcpServers, "allow");
  if (allowRules.length === 0 && !agentPromptText) {
    return baseAgents;
  }

  const existing: OpenCodeOverlayAgent = baseAgents?.[TASK_AGENT] ?? {};
  return {
    ...baseAgents,
    [TASK_AGENT]: {
      ...existing,
      ...(agentPromptText ? { system: agentPromptText } : {}),
      permissions: [...(existing.permissions ?? []), ...allowRules],
    },
  };
}

/**
 * Build the Boboddy override config layer: the baseline permission boundary
 * plus step-specific additions (MCP servers, their permission rules, the
 * task agent's system prompt and `AGENT_DEFAULT_MODEL`).
 *
 * The result is serialized into `OPENCODE_CONFIG_CONTENT`, OpenCode's
 * highest-precedence config source. The user's global and project configs are
 * left for OpenCode to load natively; its permission rules are appended after
 * theirs, so the Boboddy baseline wins on every action it names.
 */
export function buildBoboddyOverrideConfig(input: {
  /** Boboddy's embedded baseline config (permission rules, empty `mcp`). */
  baseConfig: OpenCodeOverlayConfig;
  stepMcpServers?: ResolvedOpenCodeMcpServers | null | undefined;
  agentPromptText?: string | null | undefined;
}): OpenCodeOverlayConfig {
  const baseConfig = cloneConfig(input.baseConfig);
  const denyRules = mcpToolRules(input.stepMcpServers, "deny");
  const mcp = mergeMcpConfig(baseConfig.mcp, input.stepMcpServers);
  const agents = mergeAgentsConfig(
    baseConfig.agents,
    input.stepMcpServers,
    input.agentPromptText,
  );
  const model = process.env["AGENT_DEFAULT_MODEL"];

  return {
    ...baseConfig,
    ...(model ? { model } : {}),
    ...(denyRules.length > 0
      ? { permissions: [...(baseConfig.permissions ?? []), ...denyRules] }
      : {}),
    ...(mcp ? { mcp } : {}),
    ...(agents ? { agents } : {}),
  };
}

export { TASK_AGENT };
