import { OpencodeClient, type Config } from "@opencode-ai/sdk";
import type { OpenCodeMcpServers } from "@boboddy/sdk/opencode-mcp";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";

const STEP_EXECUTION_AGENT = "build";

type OpenCodeConfig = Config;

type OpenCodeMcpConfig = NonNullable<OpenCodeConfig["mcp"]>;

type OpenCodeMcpServerConfig = OpenCodeMcpConfig[string];

function withDefinedProperties<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getRequiredMcpToolPrefixes(
  stepMcpServers: OpenCodeMcpServers | null | undefined,
): string[] {
  if (!stepMcpServers) {
    return [];
  }

  return Object.keys(stepMcpServers).map((serverName) => `${serverName}*`);
}

function toOpenCodeMcpServerConfig(
  serverConfig: OpenCodeMcpServers[string],
  baseServerConfig?: OpenCodeMcpServerConfig,
): OpenCodeMcpServerConfig | null {
  if ("type" in serverConfig) {
    if (serverConfig.type === "local") {
      const normalizedLocalConfig = withDefinedProperties({
        type: "local",
        command: [...serverConfig.command],
        environment: serverConfig.environment,
        enabled: serverConfig.enabled,
        timeout: serverConfig.timeout,
      });

      return normalizedLocalConfig as OpenCodeMcpServerConfig;
    }

    const normalizedRemoteConfig = withDefinedProperties({
      type: "remote",
      url: serverConfig.url,
      enabled: serverConfig.enabled,
      headers: serverConfig.headers,
      oauth:
        serverConfig.oauth === false
          ? false
          : serverConfig.oauth
            ? withDefinedProperties({
                clientId: serverConfig.oauth.clientId,
                clientSecret: serverConfig.oauth.clientSecret,
                scope: serverConfig.oauth.scope,
                redirectUri: serverConfig.oauth.redirectUri,
              })
            : undefined,
      timeout: serverConfig.timeout,
    });

    return normalizedRemoteConfig as OpenCodeMcpServerConfig;
  }

  if (!baseServerConfig) {
    return null;
  }

  return withDefinedProperties({
    ...baseServerConfig,
    enabled: serverConfig.enabled,
  });
}

function mergeMcpConfig(
  baseMcp: OpenCodeConfig["mcp"],
  stepMcpServers: OpenCodeMcpServers | null | undefined,
): OpenCodeConfig["mcp"] {
  if (!stepMcpServers) {
    return baseMcp;
  }

  const mergedMcp: OpenCodeMcpConfig = {
    ...(baseMcp ?? {}),
  };

  for (const [serverName, serverConfig] of Object.entries(stepMcpServers)) {
    const normalizedServerConfig = toOpenCodeMcpServerConfig(
      serverConfig,
      mergedMcp[serverName],
    );

    if (normalizedServerConfig) {
      mergedMcp[serverName] = normalizedServerConfig;
    }
  }

  return mergedMcp;
}

function mergeToolsConfig(
  baseTools: OpenCodeConfig["tools"],
  requiredPrefixes: readonly string[],
): OpenCodeConfig["tools"] {
  if (requiredPrefixes.length === 0) {
    return baseTools;
  }

  const mergedTools = {
    ...(baseTools ?? {}),
  } satisfies NonNullable<OpenCodeConfig["tools"]>;

  for (const toolPrefix of requiredPrefixes) {
    mergedTools[toolPrefix] = false;
  }

  return mergedTools;
}

function mergeAgentConfig(
  baseAgent: OpenCodeConfig["agent"],
  requiredPrefixes: readonly string[],
  agentPromptText: string | null | undefined,
): OpenCodeConfig["agent"] {
  if (requiredPrefixes.length === 0 && !agentPromptText) {
    return baseAgent;
  }

  const existingStepExecutionAgent = baseAgent?.[STEP_EXECUTION_AGENT];
  const mergedAgentTools = {
    ...(existingStepExecutionAgent?.tools ?? {}),
  } satisfies NonNullable<
    NonNullable<NonNullable<OpenCodeConfig["agent"]>[string]>["tools"]
  >;

  for (const toolPrefix of requiredPrefixes) {
    mergedAgentTools[toolPrefix] = true;
  }

  return {
    ...(baseAgent ?? {}),
    [STEP_EXECUTION_AGENT]: {
      description:
        existingStepExecutionAgent?.description ??
        "Execute Boboddy step runs with the step-specific MCP tools enabled for the current execution profile.",
      ...existingStepExecutionAgent,
      ...(agentPromptText ? { prompt: agentPromptText } : {}),
      tools: mergedAgentTools,
    },
  };
}

function mergePluginConfig(
  basePlugin: OpenCodeConfig["plugin"],
  stepPlugins: OpenCodePlugins | null | undefined,
): OpenCodeConfig["plugin"] {
  if (!stepPlugins || stepPlugins.length === 0) {
    return basePlugin;
  }

  const merged = [...(basePlugin ?? [])];

  for (const entry of stepPlugins) {
    const entryName = Array.isArray(entry) ? entry[0] : entry;
    const alreadyPresent = merged.some((existing) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const existingName = Array.isArray(existing) ? existing[0] : existing;
      return existingName === entryName;
    });
    if (!alreadyPresent) {
      merged.push(entry as NonNullable<OpenCodeConfig["plugin"]>[number]);
    }
  }

  return merged;
}

/**
 * Merge the user's project config (from `.opencode/opencode.json[c]`) onto the
 * base config. The base `permission` block always wins (security boundary).
 *
 * NOTE: This function is kept for backward-compatibility and testing purposes.
 * In the new architecture, user config is NOT merged into the override layer —
 * OpenCode loads it natively via its own config precedence chain (project
 * config #4 / `.opencode/` dirs #5).
 */
function mergeUserConfig(
  baseConfig: OpenCodeConfig,
  userConfig: OpenCodeConfig | null | undefined,
): OpenCodeConfig {
  if (!userConfig) return baseConfig;

  const mergedPlugin = mergePluginConfig(
    baseConfig.plugin,
    userConfig.plugin,
  );

  const result: OpenCodeConfig = {
    ...baseConfig,
    ...userConfig,
    // mcp: deep merge, user keys override same-named base keys
    mcp: { ...(baseConfig.mcp ?? {}), ...(userConfig.mcp ?? {}) },
  };

  // Boboddy's embedded permission block wins — security boundary
  if (baseConfig.permission !== undefined) {
    result.permission = baseConfig.permission;
  } else {
    delete result.permission;
  }

  if (mergedPlugin && mergedPlugin.length > 0) {
    result.plugin = mergedPlugin;
  } else {
    delete result.plugin;
  }

  return result;
}

/**
 * Build the Boboddy override config layer — the additions Boboddy requires on
 * top of whatever the user's project and home configs already provide.
 *
 * This is the NEW primary path. It produces only Boboddy's security boundary
 * (`permission`) plus step-specific additions (`mcp`, `tools`, `agent`,
 * `plugin`, `model`). It does NOT merge user config: the project's
 * `.opencode/opencode.json[c]` and the home `~/.config/opencode/opencode.json`
 * are left for OpenCode to load natively via its own precedence chain.
 *
 * The returned object is serialized and passed to the container as
 * `OPENCODE_CONFIG_CONTENT` (OpenCode precedence level #6 — inline), which
 * takes effect after the global (#2) and project (#4) configs. This means:
 *   - User's home config (model, providers) is applied first via #2.
 *   - Project config (repo-level MCPs, etc.) is applied next via #4.
 *   - Boboddy's overrides (permission baseline, step MCPs, AGENT_DEFAULT_MODEL)
 *     win last via #6, as required for the security boundary.
 */
export function buildBoboddyOverrideConfig(input: {
  /** Boboddy's embedded baseline config (permission block, empty mcp, etc.). */
  baseConfig: OpenCodeConfig;
  stepMcpServers?: OpenCodeMcpServers | null | undefined;
  stepPlugins?: OpenCodePlugins | null | undefined;
  agentPromptText?: string | null | undefined;
}): OpenCodeConfig {
  const baseConfig = cloneConfig(input.baseConfig);
  const requiredPrefixes = getRequiredMcpToolPrefixes(input.stepMcpServers);
  const mergedMcp = mergeMcpConfig(baseConfig.mcp, input.stepMcpServers);
  const mergedTools = mergeToolsConfig(baseConfig.tools, requiredPrefixes);
  const mergedAgent = mergeAgentConfig(
    baseConfig.agent,
    requiredPrefixes,
    input.agentPromptText,
  );
  const mergedPlugin = mergePluginConfig(baseConfig.plugin, input.stepPlugins);
  const model = process.env["AGENT_DEFAULT_MODEL"];

  return {
    ...baseConfig,
    ...(model ? { model: model } : {}),
    ...(mergedMcp ? { mcp: mergedMcp } : {}),
    ...(mergedTools ? { tools: mergedTools } : {}),
    ...(mergedAgent ? { agent: mergedAgent } : {}),
    ...(mergedPlugin && mergedPlugin.length > 0 ? { plugin: mergedPlugin } : {}),
  };
}

/**
 * Build the full merged opencode config: baseline ⊕ user project config ⊕ step
 * MCPs/plugins ⊕ AGENT_DEFAULT_MODEL.
 *
 * NOTE: In the new architecture, Boboddy no longer uses this function at
 * runtime. Boboddy's override layer is built via {@link buildBoboddyOverrideConfig}
 * and delivered as OPENCODE_CONFIG_CONTENT. This function is kept for tests that
 * exercise the merged-config merge behavior in isolation.
 */
export function buildStepExecutionOpencodeConfig(input: {
  baseConfig: OpenCodeConfig;
  userConfig?: OpenCodeConfig | null | undefined;
  stepMcpServers?: OpenCodeMcpServers | null | undefined;
  stepPlugins?: OpenCodePlugins | null | undefined;
  agentPromptText?: string | null | undefined;
}): OpenCodeConfig {
  const baseConfig = cloneConfig(input.baseConfig);
  const configWithUser = mergeUserConfig(baseConfig, input.userConfig);
  const requiredPrefixes = getRequiredMcpToolPrefixes(input.stepMcpServers);
  const mergedMcp = mergeMcpConfig(configWithUser.mcp, input.stepMcpServers);
  const mergedTools = mergeToolsConfig(configWithUser.tools, requiredPrefixes);
  const mergedAgent = mergeAgentConfig(
    configWithUser.agent,
    requiredPrefixes,
    input.agentPromptText,
  );
  const mergedPlugin = mergePluginConfig(configWithUser.plugin, input.stepPlugins);
  const model = process.env["AGENT_DEFAULT_MODEL"];

  return {
    ...configWithUser,
    ...(model ? { model: model } : {}),
    ...(mergedMcp ? { mcp: mergedMcp } : {}),
    ...(mergedTools ? { tools: mergedTools } : {}),
    ...(mergedAgent ? { agent: mergedAgent } : {}),
    ...(mergedPlugin && mergedPlugin.length > 0 ? { plugin: mergedPlugin } : {}),
  };
}

export { STEP_EXECUTION_AGENT };

void OpencodeClient;
