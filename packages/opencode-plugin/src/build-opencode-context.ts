import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

async function prepareOpencodeDir(targetRoot: string): Promise<void> {
  const pluginsRoot = path.join(targetRoot, "plugins");
  await mkdir(pluginsRoot, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(targetRoot, ".gitignore"),
      embeddedOpencodeignore as string,
      "utf8",
    ),
    writeFile(
      path.join(targetRoot, "plugins", "boboddy.js"),
      String(embeddedPluginSource),
      "utf8",
    ),
  ]);
  await Promise.all([chmod(targetRoot, 0o777), chmod(pluginsRoot, 0o777)]);
}

export async function buildOpencodeContext(input: {
  workspacePath: string;
  stepMcpServers?: OpenCodeMcpServers | null | undefined;
  stepPlugins?: OpenCodePlugins | null | undefined;
  agentPromptText?: string | null | undefined;
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

  const mergedConfig = buildStepExecutionOpencodeConfig({
    baseConfig: baselineConfig,
    userConfig,
    stepMcpServers: input.stepMcpServers,
    stepPlugins: input.stepPlugins,
    agentPromptText: input.agentPromptText,
  });
  await writeFile(
    targetConfigPath,
    `${JSON.stringify(mergedConfig, null, 2)}\n`,
    "utf8",
  );

  return mergedConfig;
}
