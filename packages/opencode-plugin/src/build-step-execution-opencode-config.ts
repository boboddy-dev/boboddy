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
      const existingName = Array.isArray(existing) ? existing[0] : existing;
      return existingName === entryName;
    });
    if (!alreadyPresent) {
      merged.push(entry as NonNullable<OpenCodeConfig["plugin"]>[number]);
    }
  }

  return merged;
}

export function buildStepExecutionOpencodeConfig(input: {
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

export { STEP_EXECUTION_AGENT };

void OpencodeClient;
