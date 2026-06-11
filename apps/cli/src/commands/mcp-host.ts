import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { runMcpHost } from "@boboddy/mcp-host";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";
import { createCliLogger } from "../lib/logger";

export interface McpHostArguments {
  workspace: string;
  port: number;
  pluginsJson?: string;
}

const logger = createCliLogger("mcp-host");

async function handler(
  arguments_: ArgumentsCamelCase<McpHostArguments>,
): Promise<void> {
  let plugins: OpenCodePlugins = [];

  if (arguments_.pluginsJson) {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(arguments_.pluginsJson, "utf8");
      plugins = JSON.parse(raw) as OpenCodePlugins;
    } catch (error) {
      logger.error({ err: error, pluginsJson: arguments_.pluginsJson }, "Failed to read plugins JSON — starting with no plugins");
    }
  }

  const stop = await runMcpHost({
    workspacePath: arguments_.workspace,
    port: arguments_.port,
    plugins,
    logger,
  });

  // Wait for SIGINT or SIGTERM to gracefully shut down
  const shutdown = () => {
    logger.info("Received shutdown signal, stopping");
    stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise<void>(() => {
    // Intentionally never resolves — server runs until signal
  });
}

export const mcpHostCommand: CommandModule<object, McpHostArguments> = {
  command: "mcp-host",
  describe: false,
  builder: (argv: Argv<object>) =>
    argv
      .option("workspace", {
        describe: "Absolute path to the workspace directory",
        type: "string",
        demandOption: true,
      })
      .option("port", {
        describe: "Port to bind the MCP HTTP server on",
        type: "number",
        demandOption: true,
      })
      .option("pluginsJson", {
        alias: "plugins-json",
        describe: "Path to a JSON file containing the resolved plugin list",
        type: "string",
        demandOption: false,
      }),
  handler,
};
