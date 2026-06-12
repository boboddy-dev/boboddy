import pino from "pino";
import type { McpHostOptions } from "./types";
import { loadPluginTools, loadToolFiles } from "./plugin-loader";
import { createMcpHttpServer } from "./mcp-server";

/**
 * Start the MCP host server.
 *
 * Loads user tools from:
 *   1. Tool files in `userToolsDir` (relocated from `.opencode/tools/`)
 *   2. npm plugins listed in `plugins`
 *
 * Starts an HTTP MCP server on `0.0.0.0:<port>` and returns a stop function.
 */
export async function runMcpHost(options: McpHostOptions): Promise<() => void> {
  const { workspacePath, port, plugins, userToolsDir } = options;
  const logger = options.logger ?? pino({
    name: "mcp-host",
    level: process.env["BOBODDY_LOG_LEVEL"] ?? "info",
  });

  logger.info(
    { workspacePath, port, pluginCount: plugins.length, userToolsDir: userToolsDir ?? null },
    "Starting MCP host",
  );

  // Load tool files and npm plugin tools in parallel
  const [toolFileResults, pluginResults] = await Promise.all([
    userToolsDir
      ? loadToolFiles(userToolsDir, workspacePath, logger)
      : Promise.resolve([]),
    loadPluginTools(workspacePath, plugins, logger),
  ]);

  const { tools: pluginTools, warnings } = pluginResults;
  const allTools = [...toolFileResults, ...pluginTools];

  for (const warning of warnings) {
    logger.warn(
      { pluginName: warning.pluginName, droppedHooks: warning.droppedHooks },
      "Plugin returned unsupported hooks — ignored in devcontainer MCP host (v1 limitation)",
    );
  }

  logger.info(
    { toolCount: allTools.length, tools: allTools.map((t) => t.name) },
    "MCP host tools loaded",
  );

  const toolMap = new Map(allTools.map((t) => [t.name, t]));
  const server = createMcpHttpServer({ tools: toolMap, warnings }, port);

  logger.info({ port: server.port }, "MCP host listening");

  return () => {
    server.stop(true);
  };
}
