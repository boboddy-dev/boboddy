import type { Logger } from "pino";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";

/**
 * Options for running the MCP host server.
 */
export type McpHostOptions = {
  /**
   * Absolute path to the workspace (project root — same as /workspace inside containers).
   */
  workspacePath: string;

  /**
   * Port to listen on (0.0.0.0:<port>).
   */
  port: number;

  /**
   * User-defined npm plugins to load. Each entry is a plugin name + optional options,
   * matching the OpenCode plugin[] config format.
   */
  plugins: OpenCodePlugins;

  /**
   * Pino logger instance. Defaults to a new logger named "mcp-host" if omitted.
   * The CLI command passes in createCliLogger("mcp-host") so output flows through
   * the shared CLI transport.
   */
  logger?: Logger;
};

/**
 * A discovered tool ready to be served via MCP.
 */
export type DiscoveredTool = {
  /** Fully-qualified MCP tool name, e.g. "my-plugin_my-tool" */
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /**
   * Execute the tool with the given parsed arguments.
   * Returns a string result.
   */
  execute: (args: Record<string, unknown>) => Promise<string>;
};
