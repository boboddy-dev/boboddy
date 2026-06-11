import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, symlink, rm, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";
import type { DiscoveredTool } from "./types";
import { zodShapeToJsonSchema } from "./zod-to-json-schema";
import arboristInstallScript from "./arborist-install.js" with { type: "text" };

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
 * Inline Node.js script used to discover tool exports from a single tool file.
 *
 * Spawned as: node --input-type=module
 * Environment: NODE_PATH=<workspace>/.opencode/node_modules
 * Stdin: JSON { filePath, workspacePath }
 * Stdout: JSON { tools: [{ exportName, description, inputSchema }] } or { error: string }
 *
 * We use `z.toJSONSchema` if available (Zod v4) or fall back to an empty schema.
 */
const DISCOVER_SCRIPT = `
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { filePath, workspacePath } = input;

// Extend module resolution to include .opencode/node_modules
// Node's NODE_PATH env handles this, but we also override createRequire for safety.

try {
  const fileUrl = pathToFileURL(filePath).href;
  const mod = await import(fileUrl);
  const tools = [];

  for (const [exportName, exportValue] of Object.entries(mod)) {
    if (!exportValue || typeof exportValue !== 'object') continue;
    const def = exportValue._def ?? exportValue;
    // A tool() result has .execute, .description, .args
    if (typeof exportValue.execute !== 'function') continue;

    let inputSchema = { type: 'object', properties: {} };
    if (exportValue.args && typeof exportValue.args === 'object') {
      try {
        // Try Zod v4 toJSONSchema
        const zod = await import('zod').catch(() => null);
        if (zod && typeof zod.z?.toJSONSchema === 'function') {
          const fullSchema = zod.z.toJSONSchema(zod.z.object(exportValue.args));
          inputSchema = {
            type: 'object',
            properties: fullSchema.properties ?? {},
            ...(Array.isArray(fullSchema.required) ? { required: fullSchema.required } : {}),
            additionalProperties: false,
          };
        }
      } catch {}
    }

    tools.push({
      exportName,
      description: typeof exportValue.description === 'string' ? exportValue.description : \`Tool \${exportName}\`,
      inputSchema,
    });
  }

  process.stdout.write(JSON.stringify({ tools }) + '\\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err?.message ?? String(err) }) + '\\n');
}
`.trim();

/**
 * Inline Node.js script used to execute a single tool call.
 *
 * Spawned as: node --input-type=module
 * Environment: NODE_PATH=<workspace>/.opencode/node_modules
 * Stdin: JSON { filePath, exportName, args, workspacePath }
 * Stdout: JSON { output: string } or { error: string }
 */
const EXECUTE_SCRIPT = `
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { filePath, exportName, args, workspacePath } = input;

try {
  const mod = await import(pathToFileURL(filePath).href);
  const toolDef = exportName === 'default' ? mod.default : mod[exportName];
  if (!toolDef || typeof toolDef.execute !== 'function') {
    throw new Error(\`Export "\${exportName}" is not a tool\`);
  }

  const ctx = {
    sessionID: 'mcp-host',
    messageID: 'mcp-host',
    agent: 'build',
    directory: workspacePath,
    worktree: workspacePath,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };

  const result = await toolDef.execute(args, ctx);

  let output;
  if (typeof result === 'string') {
    output = result;
  } else if (result && typeof result === 'object' && 'output' in result) {
    output = String(result.output);
  } else {
    output = String(result);
  }

  process.stdout.write(JSON.stringify({ output }) + '\\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err?.message ?? String(err) }) + '\\n');
}
`.trim();

/**
 * Run a Node.js ESM script with the given input embedded directly as a JSON string constant.
 * The script references `readFileSync('/dev/stdin', 'utf8')` which gets replaced with
 * the serialized input, so the subprocess needs no stdin plumbing.
 */
function runNodeScriptWithInput(
  script: string,
  input: unknown,
  timeoutMs: number,
  cwd?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const inputJson = JSON.stringify(input);
    // Embed the JSON input directly into the script so the subprocess is fully self-contained.
    const scriptWithInput = script.replace(
      "readFileSync('/dev/stdin', 'utf8')",
      `${JSON.stringify(inputJson)}`,
    );

    const proc = spawn("node", ["--input-type=module"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      reject(new Error(`Node subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      try {
        const lastLine = stdout.trim().split("\n").at(-1) ?? "";
        resolve(JSON.parse(lastLine));
      } catch {
        reject(new Error(`node subprocess (exit ${code ?? "?"}) stderr: ${stderr.slice(0, 500)}`));
      }
    });

    proc.stdin.end(scriptWithInput);
  });
}

type ToolDiscoveryResult = {
  tools?: Array<{ exportName: string; description: string; inputSchema: DiscoveredTool["inputSchema"] }>;
  error?: string;
};

type ToolExecutionResult = {
  output?: string;
  error?: string;
};



/**
 * Ensure `.opencode/node_modules` is populated using arborist if
 * `.opencode/package.json` exists but `node_modules` is absent.
 *
 * Arborist is loaded from npm's bundled copy via a Node.js subprocess so it
 * never needs to be bundled into the Bun binary (which breaks due to
 * node-gyp path baking) and never requires npm to be on PATH.
 */
async function ensureOpencodeNodeModules(
  workspacePath: string,
  logger: Logger,
): Promise<void> {
  const opencodeDir = path.join(workspacePath, ".opencode");
  const packageJsonPath = path.join(opencodeDir, "package.json");
  const nodeModulesPath = path.join(opencodeDir, "node_modules");

  // Only proceed if there is a package.json to install from
  try {
    await access(packageJsonPath);
  } catch {
    return; // No package.json — nothing to install
  }

  // Check if node_modules already exists (any install happened)
  try {
    await access(nodeModulesPath);
    return; // Already installed
  } catch {
    // node_modules absent — fall through to install
  }

  logger.info({ opencodeDir }, "Installing .opencode dependencies before loading tool files");
  try {
    const result = await runNodeScriptWithInput(
      arboristInstallScript,
      { opencodeDir },
      120_000,
    ) as { ok?: boolean; error?: string };

    if (result.error) {
      throw new Error(result.error);
    }

    logger.info({ opencodeDir }, ".opencode dependency install complete");
  } catch (err) {
    // Non-fatal — log and continue; tools that need the deps will fail at discovery time
    logger.warn(
      { opencodeDir, err: err instanceof Error ? err.message : String(err) },
      "Failed to install .opencode dependencies — tool files may fail to load",
    );
  }
}

/**
 * Load tools from `.opencode/tools/`-style files in `userToolsDir`.
 *
 * Uses a Node.js subprocess for each file so that user tool files can resolve
 * their own dependencies (e.g. `@opencode-ai/plugin`, `pg`) from the workspace's
 * `.opencode/node_modules` via NODE_PATH — something that isn't possible from
 * inside a compiled Bun binary.
 *
 * OpenCode 1.15.13 naming convention:
 *   - default export → `<filename>`
 *   - named export   → `<filename>_<exportName>`
 */
export async function loadToolFiles(
  userToolsDir: string,
  workspacePath: string,
  logger: Logger,
): Promise<DiscoveredTool[]> {
  const tools: DiscoveredTool[] = [];

  let entries: string[];
  try {
    entries = await readdir(userToolsDir);
  } catch {
    return tools;
  }

  const toolFiles = entries.filter(
    (e) => (e.endsWith(".ts") || e.endsWith(".js")) && !e.startsWith("_"),
  );

  // Ensure .opencode/node_modules is installed before symlinking and loading.
  // This handles the race where the MCP host starts before the AI container
  // has had a chance to run npm install for .opencode/package.json.
  await ensureOpencodeNodeModules(workspacePath, logger);

  // Symlink .opencode/node_modules into userToolsDir so Node's ESM resolver finds
  // the workspace's dependencies (e.g. @opencode-ai/plugin, pg) when importing tool files.
  const opencodeNodeModules = path.join(workspacePath, ".opencode", "node_modules");
  const userToolsNodeModules = path.join(userToolsDir, "node_modules");
  try {
    await rm(userToolsNodeModules, { force: true });
    await symlink(opencodeNodeModules, userToolsNodeModules);
  } catch {
    // Non-fatal — tools may still load if deps are available elsewhere
  }

  for (const filename of toolFiles) {
    const filePath = path.join(userToolsDir, filename);
    const baseName = filename.replace(/\.(ts|js)$/, "");

    try {
      const result = await runNodeScriptWithInput(
        DISCOVER_SCRIPT,
        { filePath, workspacePath },
        15_000,
        userToolsDir,
      ) as ToolDiscoveryResult;

      if (result.error) {
        logger.error({ file: filename, nodeError: result.error }, "Failed to discover tool file — skipping");
        continue;
      }

      for (const toolDesc of result.tools ?? []) {
        const mcpName = toolDesc.exportName === "default"
          ? baseName
          : `${baseName}_${toolDesc.exportName}`;

        const capturedFilePath = filePath;
        const capturedExportName = toolDesc.exportName;
        const capturedMcpName = mcpName;

        tools.push({
          name: mcpName,
          description: toolDesc.description,
          inputSchema: toolDesc.inputSchema,
          execute: async (args: Record<string, unknown>): Promise<string> => {
            const execResult = await runNodeScriptWithInput(
              EXECUTE_SCRIPT,
              { filePath: capturedFilePath, exportName: capturedExportName, args, workspacePath },
              TOOL_EXECUTION_TIMEOUT_MS,
              userToolsDir,
            ) as ToolExecutionResult;

            if (execResult.error) {
              throw new Error(execResult.error);
            }

            let output = execResult.output ?? "";
            if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
              output = Buffer.from(output, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8")
                + `\n[mcp-host: output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
            }
            return output;
          },
        });

        logger.info({ file: filename, toolName: mcpName }, "Tool file registered");
      }
    } catch (error) {
      logger.error({ err: error, file: filename }, "Failed to load tool file — skipping");
    }
  }

  return tools;
}

/** Build the capped, timed-out execute wrapper shared by both loaders. */
function makeExecuteFn(
  execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>,
  mcpName: string,
  workspacePath: string,
): (args: Record<string, unknown>) => Promise<string> {
  return async (args: Record<string, unknown>): Promise<string> => {
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
      execute(args, ctx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Tool "${mcpName}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)),
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
  };
}

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

        tools.push({
          name: mcpName,
          description: toolDef.description ?? `Tool ${mcpName}`,
          inputSchema,
          execute: makeExecuteFn(toolDef.execute, mcpName, workspacePath),
        });

        logger.info({ pluginName: name, toolName: mcpName }, "Tool registered");
      }
    } catch (error) {
      logger.error({ err: error, pluginName: name }, "Failed to load plugin — skipping");
    }
  }

  return { tools, warnings };
}
