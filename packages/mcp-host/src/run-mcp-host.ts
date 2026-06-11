import pino from "pino";
import type { McpHostOptions } from "./types";
import { loadPluginTools } from "./plugin-loader";
import { createMcpHttpServer } from "./mcp-server";

/**
 * Start the MCP host server.
 *
 * Loads all user tools from npm plugins and starts an HTTP MCP server
 * on `0.0.0.0:<port>`.
 *
 * Returns a stop function that shuts down the server.
 */
export async function runMcpHost(options: McpHostOptions): Promise<() => void> {
  const { workspacePath, port, plugins } = options;
  const logger = options.logger ?? pino({
    name: "mcp-host",
    level: process.env["BOBODDY_LOG_LEVEL"] ?? "info",
  });

  logger.info({ workspacePath, port, pluginCount: plugins.length }, "Starting MCP host");

  const { tools, warnings } = await loadPluginTools(workspacePath, plugins, logger);

  for (const warning of warnings) {
    logger.warn(
      { pluginName: warning.pluginName, droppedHooks: warning.droppedHooks },
      "Plugin returned unsupported hooks — ignored in devcontainer MCP host (v1 limitation)",
    );
  }

  logger.info(
    { toolCount: tools.length, tools: tools.map((t) => t.name) },
    "MCP host tools loaded",
  );

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const server = createMcpHttpServer({ tools: toolMap, warnings }, port);

  logger.info({ port: server.port }, "MCP host listening");

  return () => {
    server.stop(true);
  };
}
