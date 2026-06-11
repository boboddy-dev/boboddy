import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "@opencode-ai/sdk";
import type { OpenCodeMcpServers } from "@boboddy/sdk/opencode-mcp";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";
import { parseJsonc } from "@boboddy/sdk/jsonc";
import { buildStepExecutionOpencodeConfig } from "./build-step-execution-opencode-config";
import embeddedOpencodeJsonc from "../opencode.jsonc" with { type: "text" };
import embeddedOpencodeignore from "../opencodeignore.txt" with { type: "text" };
import embeddedPluginSource from "../dist/plugin.js" with { type: "text" };

function parseJsoncConfig(content: string): Config {
  return parseJsonc(content) as Config;
}

async function readUserOpencodeConfig(
  workspacePath: string,
): Promise<Config | null> {
  const candidates = [
    path.join(workspacePath, ".opencode", "opencode.json"),
    path.join(workspacePath, ".opencode", "opencode.jsonc"),
  ];

  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf8");
      return parseJsoncConfig(content);
    } catch {
      // File doesn't exist or is unreadable — try next candidate
    }
  }

  return null;
}

/**
 * OpenCode 1.15.13 auto-scans these two glob patterns inside any `.opencode/` dir:
 *   {tool,tools}/*.{js,ts}    → loaded as plugin tool files
 *   {plugin,plugins}/*.{ts,js} → loaded as plugin modules
 *
 * To prevent untrusted user code from running inside the AI container, we must
 * ensure neither of those directories contains user-authored files before the
 * AI container starts.
 *
 * For `.opencode/tools/`: the AI container has this path shadowed by a `--tmpfs`
 * mount (see docker-ai-container-launcher.ts), so opencode never sees any files
 * there regardless of what the user put in `.opencode/tools/`. No relocation needed.
 * The devcontainer MCP host reads the real files directly from the shared workspace.
 *
 * For `.opencode/plugins/`: we still scrub user-authored plugin files here, keeping
 * only `boboddy.js` (the single trusted plugin).
 */
async function scrubUserPlugins(opencodeRoot: string): Promise<void> {
  const pluginsDir = path.join(opencodeRoot, "plugins");
  try {
    const pluginEntries = await readdir(pluginsDir);
    const removePromises: Promise<void>[] = [];
    for (const entry of pluginEntries) {
      if (entry === "boboddy.js") continue; // keep the trusted plugin
      if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        removePromises.push(
          rm(path.join(pluginsDir, entry), { force: true }),
        );
      }
    }
    await Promise.all(removePromises);
  } catch {
    // plugins/ doesn't exist yet — will be created by prepareOpencodeDir
  }
}

async function prepareOpencodeDir(targetRoot: string): Promise<void> {
  const pluginsRoot = path.join(targetRoot, "plugins");
  await mkdir(pluginsRoot, { recursive: true });

  // Scrub user-authored plugin files before writing boboddy.js.
  // .opencode/tools/ is protected by a --tmpfs mount on the AI container instead.
  await scrubUserPlugins(targetRoot);

  await Promise.all([
    writeFile(
      path.join(targetRoot, ".gitignore"),
      embeddedOpencodeignore as string,
      "utf8",
    ),
    writeFile(
      path.join(pluginsRoot, "boboddy.js"),
      String(embeddedPluginSource),
      "utf8",
    ),
  ]);
  await Promise.all([chmod(targetRoot, 0o777), chmod(pluginsRoot, 0o777)]);
}

/**
 * The bridge MCP server name used to expose user tools from the devcontainer.
 * Must start with "boboddy" so the existing permission allow-rule and agent
 * gating (mergeToolsConfig / mergeAgentConfig) cover it automatically.
 */
export const USER_TOOLS_MCP_SERVER_NAME = "boboddy-user-tools";

/**
 * The workspace-relative path where user tool files live.
 * These are the original .opencode/tools/ files — they stay in place and the
 * AI container has this path shadowed by a --tmpfs mount so opencode never
 * auto-scans them. The devcontainer MCP host reads directly from this path.
 */
export const USER_TOOLS_DIR = ".opencode/tools";

export async function buildOpencodeContext(input: {
  workspacePath: string;
  stepMcpServers?: OpenCodeMcpServers | null | undefined;
  /**
   * User/npm plugins. These are intentionally NOT forwarded into config.plugin[]
   * on the AI side — their tools reach the AI container via the devcontainer MCP host.
   * Pass null or omit when calling from the orchestrator (it handles the forwarding
   * separately via mcpHostManager).
   */
  stepPlugins?: OpenCodePlugins | null | undefined;
  agentPromptText?: string | null | undefined;
  /**
   * If the devcontainer MCP host is running, the HTTP URL to its /mcp endpoint,
   * e.g. "http://devcontainer:40751/mcp".
   *
   * When provided, a remote MCP server entry named "boboddy-user-tools" is injected
   * into the merged config, and the tool prefix is gated for the build agent.
   *
   * Omit or pass undefined to skip injection (no user tools or host didn't start).
   */
  userToolsMcpUrl?: string | undefined;
}): Promise<Config> {
  const targetRoot = path.join(input.workspacePath, ".opencode");
  const targetConfigPath = path.join(targetRoot, "opencode.json");

  const baselineConfig = JSON.parse(
    JSON.stringify(parseJsoncConfig(embeddedOpencodeJsonc as string)),
  ) as Config;

  const [userConfig] = await Promise.all([
    readUserOpencodeConfig(input.workspacePath),
    prepareOpencodeDir(targetRoot),
  ]);

  // Inject the bridge MCP server if the host is available.
  // We merge it into the stepMcpServers so it flows through the existing
  // mergeMcpConfig / mergeToolsConfig / mergeAgentConfig pipeline and gets
  // added to the build agent's allowed tools automatically.
  let effectiveStepMcpServers: OpenCodeMcpServers | null | undefined =
    input.stepMcpServers;

  if (input.userToolsMcpUrl) {
    effectiveStepMcpServers = {
      ...(effectiveStepMcpServers ?? {}),
      [USER_TOOLS_MCP_SERVER_NAME]: {
        type: "remote" as const,
        url: input.userToolsMcpUrl,
        enabled: true,
      },
    };
  }

  // Strip plugin[] from userConfig before merging into the AI config.
  // User/npm plugins are forwarded to the devcontainer MCP host instead —
  // their tools reach the AI container via the boboddy-user-tools remote MCP server.
  // Leaving plugin[] here would cause OpenCode to auto-load untrusted npm packages
  // inside the AI container.
  let sanitizedUserConfig = userConfig;
  if (userConfig?.plugin && (userConfig.plugin as unknown[]).length > 0) {
    const { plugin: _dropped, ...rest } = userConfig;
    sanitizedUserConfig = Object.keys(rest).length > 0 ? rest as typeof userConfig : null;
  }

  const mergedConfig = buildStepExecutionOpencodeConfig({
    baseConfig: baselineConfig,
    userConfig: sanitizedUserConfig,
    stepMcpServers: effectiveStepMcpServers,
    // stepPlugins are NOT forwarded to the AI container — they run in the devcontainer
    // MCP host and their tools arrive via boboddy-user-tools remote MCP server.
    stepPlugins: null,
    agentPromptText: input.agentPromptText,
  });
  await writeFile(
    targetConfigPath,
    `${JSON.stringify(mergedConfig, null, 2)}\n`,
    "utf8",
  );

  return mergedConfig;
}
