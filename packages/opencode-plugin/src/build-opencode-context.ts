import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "@opencode-ai/sdk";
import type { OpenCodeMcpServers } from "@boboddy/sdk/opencode-mcp";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";
import { parseJsonc } from "@boboddy/sdk/jsonc";
import { buildBoboddyOverrideConfig } from "./build-step-execution-opencode-config";
import embeddedOpencodeJsonc from "../opencode.jsonc" with { type: "text" };
import embeddedOpencodeignore from "../opencodeignore.txt" with { type: "text" };
import embeddedPluginSource from "../dist/plugin.js" with { type: "text" };

function parseJsoncConfig(content: string): Config {
  return parseJsonc(content) as Config;
}

/**
 * Prepare the `.opencode/` directory the in-container OpenCode reads from.
 *
 * OpenCode runs INSIDE the user's devcontainer (single-container model), so
 * user `.opencode/tools/*` files and `plugin[]` entries are trusted and load
 * normally. The only thing we materialize here is the embedded Boboddy plugin
 * (`plugins/boboddy.js`) and the ignore file. User plugin files in
 * `.opencode/plugins/` are left in place alongside `boboddy.js`.
 *
 * NOTE: We do NOT write `opencode.json` here. The project's existing
 * `.opencode/opencode.json[c]` (if any) is left completely untouched so that
 * the user's repo stays clean. OpenCode loads it natively at precedence level
 * #4 (project config). Boboddy's additions are delivered via
 * `OPENCODE_CONFIG_CONTENT` at precedence level #6 (inline override).
 */
async function prepareOpencodeDir(targetRoot: string): Promise<void> {
  const pluginsRoot = path.join(targetRoot, "plugins");
  await mkdir(pluginsRoot, { recursive: true });

  await Promise.all([
    writeFile(
      path.join(targetRoot, ".gitignore"),
      embeddedOpencodeignore,
      "utf8",
    ),
    writeFile(
      path.join(pluginsRoot, "boboddy.js"),
      embeddedPluginSource as unknown as string,
      "utf8",
    ),
  ]);
  await Promise.all([chmod(targetRoot, 0o777), chmod(pluginsRoot, 0o777)]);
}

/**
 * Build the Boboddy OpenCode context for a step execution.
 *
 * Returns a JSON string (`opencodeConfigContent`) that must be passed to the
 * in-container OpenCode as the `OPENCODE_CONFIG_CONTENT` environment variable.
 * This string carries Boboddy's required overrides (permission baseline, step
 * MCP servers, step plugins, AGENT_DEFAULT_MODEL) at precedence level #6
 * (inline), ensuring they win over the user's global (#2) and project (#4)
 * configs without modifying any files in the user's repo.
 *
 * Side effects:
 *   - Creates `.opencode/plugins/` directory in `workspacePath`.
 *   - Writes `.opencode/plugins/boboddy.js` (the embedded Boboddy plugin).
 *   - Writes `.opencode/.gitignore` (the embedded ignore file).
 *
 * The project's `.opencode/opencode.json[c]` is NOT read or written.
 */
export async function buildOpencodeContext(input: {
  workspacePath: string;
  stepMcpServers?: OpenCodeMcpServers | null | undefined;
  /**
   * User/npm plugins declared for the step. OpenCode runs in the same container
   * as the workspace, so these are trusted and merged directly into
   * `config.plugin[]` to load in-process.
   */
  stepPlugins?: OpenCodePlugins | null | undefined;
  agentPromptText?: string | null | undefined;
}): Promise<{ opencodeConfigContent: string }> {
  const targetRoot = path.join(input.workspacePath, ".opencode");

  const baselineConfig = JSON.parse(
    JSON.stringify(parseJsoncConfig(embeddedOpencodeJsonc as string)),
  ) as Config;

  // Prepare the .opencode/ dir (plugin + gitignore) while computing the
  // override config in parallel.
  const [overrideConfig] = await Promise.all([
    Promise.resolve(
      buildBoboddyOverrideConfig({
        baseConfig: baselineConfig,
        stepMcpServers: input.stepMcpServers,
        stepPlugins: input.stepPlugins,
        agentPromptText: input.agentPromptText,
      }),
    ),
    prepareOpencodeDir(targetRoot),
  ]);

  const opencodeConfigContent = `${JSON.stringify(overrideConfig, null, 2)}\n`;

  return { opencodeConfigContent };
}
