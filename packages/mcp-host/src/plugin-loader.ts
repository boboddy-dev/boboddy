import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";
import type { DiscoveredTool } from "./types";
import { zodShapeToJsonSchema } from "./zod-to-json-schema";

const execFileAsync = promisify(execFile);

/**
 * Per-call timeout for user tool execution (ms).
 */
const TOOL_EXECUTION_TIMEOUT_MS = 60_000;

/**
 * Maximum output size from a single tool call (bytes).
 */
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KiB

/**
 * Directory inside the devcontainer where npm plugins are installed.
 */
const PLUGIN_INSTALL_DIR = "/tmp/boboddy-mcp-host/plugins";

/**
 * Hooks warning structure — logs what was dropped.
 */
export type PluginHookWarning = {
  pluginName: string;
  droppedHooks: string[];
};

/** All hook keys that plugins may return — we accept only "tool" */
const KNOWN_HOOK_KEYS = new Set([
  "dispose",
  "event",
  "config",
  "auth",
  "provider",
  "chat.message",
  "chat.params",
  "chat.headers",
  "permission.ask",
  "command.execute.before",
  "tool.execute.before",
  "tool.execute.after",
  "shell.env",
  "tool.definition",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.provider.small_model",
  "experimental.session.compacting",
  "experimental.compaction.autocontinue",
  "experimental.text.complete",
]);

function isHookKey(key: string): boolean {
  return KNOWN_HOOK_KEYS.has(key) || key.startsWith("experimental.");
}

/**
 * Build a minimal PluginInput shim for the MCP host.
 *
 * v1: only `directory`, `worktree`, `$` (Bun shell), and a no-op `client`.
 * Hooks other than `tool` are ignored with a warning.
 */
function buildPluginInputShim(workspacePath: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noopClient = new Proxy({} as any, {
    get() {
      return () => Promise.resolve(undefined);
    },
  });

  return {
    directory: workspacePath,
    worktree: workspacePath,
    serverUrl: new URL("http://localhost"),
    project: { path: workspacePath },
    experimental_workspace: { register: () => undefined },
    $: typeof Bun !== "undefined" ? Bun.$ : undefined,
    client: noopClient,
  };
}

/**
 * Derive a safe MCP tool name from a plugin package name and tool key.
 *
 * "@scope/pkg-name" + "toolKey" → "scope-pkg-name_toolKey"
 */
function deriveMcpToolName(pluginName: string, toolKey: string): string {
  const sanitized = pluginName
    .replace(/^@/, "")
    .replaceAll("/", "-")
    .replaceAll(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${sanitized}_${toolKey}`;
}

/**
 * Install npm plugins into PLUGIN_INSTALL_DIR using `bun install`.
 */
async function installNpmPlugins(
  pluginPackageNames: string[],
  logger: Logger,
): Promise<void> {
  if (pluginPackageNames.length === 0) return;

  await mkdir(PLUGIN_INSTALL_DIR, { recursive: true });

  const packageJson = {
    name: "boboddy-mcp-host-plugins",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(pluginPackageNames.map((name) => [name, "latest"])),
  };

  const packageJsonPath = path.join(PLUGIN_INSTALL_DIR, "package.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n", "utf8");

  logger.info({ packages: pluginPackageNames }, "Installing npm plugins");
  await execFileAsync("bun", ["install", "--no-save"], { cwd: PLUGIN_INSTALL_DIR });
  logger.info("npm plugin install complete");
}

/**
 * Attempt to dynamically import a plugin module by package name from PLUGIN_INSTALL_DIR.
 */
async function importPlugin(packageName: string): Promise<unknown> {
  const modulePath = path.join(PLUGIN_INSTALL_DIR, "node_modules", packageName);
  return import(modulePath);
}

type PluginModule = {
  server?: (input: unknown, options?: unknown) => Promise<Record<string, unknown>>;
  default?: {
    server?: (input: unknown, options?: unknown) => Promise<Record<string, unknown>>;
  };
};

type ToolDefinition = {
  description: string;
  args?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: unknown) => Promise<unknown>;
};

/**
 * Load tools from all user npm plugins.
 *
 * Returns discovered tools and any hook warnings.
 */
export async function loadPluginTools(
  workspacePath: string,
  plugins: OpenCodePlugins,
  logger: Logger,
): Promise<{
  tools: DiscoveredTool[];
  warnings: PluginHookWarning[];
}> {
  const tools: DiscoveredTool[] = [];
  const warnings: PluginHookWarning[] = [];

  if (plugins.length === 0) {
    return { tools, warnings };
  }

  const npmPlugins: Array<{ name: string; options: Record<string, unknown> }> = [];

  for (const entry of plugins) {
    const [name, options] = Array.isArray(entry)
      ? [entry[0], entry[1] as Record<string, unknown>]
      : [entry as string, {} as Record<string, unknown>];

    // File-based plugins are not supported in v1
    if (name.startsWith(".") || name.startsWith("/") || name.startsWith("file:")) {
      warnings.push({ pluginName: name, droppedHooks: ["*"] });
      logger.warn({ pluginName: name }, "Skipping file-based plugin — only npm plugins are supported in v1");
      continue;
    }

    npmPlugins.push({ name, options });
  }

  if (npmPlugins.length === 0) {
    return { tools, warnings };
  }

  const packageNames = npmPlugins.map((p) => p.name);
  try {
    await installNpmPlugins(packageNames, logger);
  } catch (error) {
    logger.error({ err: error }, "Failed to install npm plugins — no user tools will be available");
    return { tools, warnings };
  }

  const pluginInput = buildPluginInputShim(workspacePath);

  for (const { name, options } of npmPlugins) {
    try {
      const mod = (await importPlugin(name)) as PluginModule;
      const pluginModule = mod.default ?? mod;
      const serverFn = typeof pluginModule === "function" ? pluginModule : pluginModule?.server;

      if (typeof serverFn !== "function") {
        logger.warn({ pluginName: name }, "Plugin has no server() export — skipping");
        continue;
      }

      const hooks = (await serverFn(pluginInput, options)) as Record<string, unknown>;

      if (!hooks || typeof hooks !== "object") {
        logger.warn({ pluginName: name }, "Plugin returned no hooks — skipping");
        continue;
      }

      // Collect unsupported hooks (everything except "tool")
      const droppedHooks = Object.keys(hooks).filter((k) => k !== "tool" && isHookKey(k));
      if (droppedHooks.length > 0) {
        warnings.push({ pluginName: name, droppedHooks });
        // The caller (run-mcp-host.ts) will log a warn per warning after this returns
      }

      const toolMap = hooks["tool"] as Record<string, ToolDefinition> | undefined;
      if (!toolMap || typeof toolMap !== "object") {
        logger.info({ pluginName: name }, "Plugin loaded (no tools exported)");
        continue;
      }

      for (const [toolKey, toolDef] of Object.entries(toolMap)) {
        if (!toolDef || typeof toolDef !== "object") continue;
        if (typeof toolDef.execute !== "function") continue;

        const mcpName = deriveMcpToolName(name, toolKey);

        let inputSchema: DiscoveredTool["inputSchema"];
        if (toolDef.args && typeof toolDef.args === "object") {
          try {
            inputSchema = zodShapeToJsonSchema(
              toolDef.args as Record<string, import("zod").ZodTypeAny>,
            );
          } catch {
            inputSchema = { type: "object", properties: {} };
          }
        } else {
          inputSchema = { type: "object", properties: {} };
        }

        const capturedExecute = toolDef.execute;
        const capturedMcpName = mcpName;

        tools.push({
          name: mcpName,
          description: toolDef.description ?? `Tool ${capturedMcpName}`,
          inputSchema,
          execute: async (args: Record<string, unknown>): Promise<string> => {
            const ctx = {
              sessionID: "mcp-host",
              messageID: "mcp-host",
              agent: "build",
              directory: workspacePath,
              worktree: workspacePath,
              abort: AbortSignal.timeout(TOOL_EXECUTION_TIMEOUT_MS),
              metadata: () => undefined,
              ask: async () => undefined,
            };

            const result = await Promise.race([
              capturedExecute(args, ctx),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Tool "${capturedMcpName}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)),
                  TOOL_EXECUTION_TIMEOUT_MS,
                ),
              ),
            ]);

            let output: string;
            if (typeof result === "string") {
              output = result;
            } else if (result && typeof result === "object" && "output" in result) {
              output = String((result as { output: unknown }).output);
            } else {
              output = String(result);
            }

            if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
              const truncated = Buffer.from(output, "utf8")
                .subarray(0, MAX_OUTPUT_BYTES)
                .toString("utf8");
              output = truncated + `\n[mcp-host: output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
            }

            return output;
          },
        });

        logger.info({ pluginName: name, toolName: mcpName }, "Tool registered");
      }
    } catch (error) {
      logger.error({ err: error, pluginName: name }, "Failed to load plugin — skipping");
    }
  }

  return { tools, warnings };
}
