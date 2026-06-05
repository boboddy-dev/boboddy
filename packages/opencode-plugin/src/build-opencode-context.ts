import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "@opencode-ai/sdk";
import type { OpenCodeMcpServers } from "@boboddy/sdk/opencode-mcp";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";
import { parseJsonc } from "@boboddy/sdk/jsonc";
import { buildStepExecutionOpencodeConfig } from "./build-step-execution-opencode-config";
import embeddedOpencodeJsonc from "../opencode.jsonc" with { type: "text" };
import embeddedOpencodeignore from "../opencodeignore.txt" with { type: "text" };

let embeddedPluginSourcePromise: Promise<string> | null = null;

function parseJsoncConfig(content: string): Config {
  return parseJsonc(content) as Config;
}

async function loadEmbeddedPluginSource(): Promise<string> {
  try {
    return await readFile(new URL("../dist/plugin.js", import.meta.url), "utf8");
  } catch {
    const result = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "plugin.ts")],
      format: "esm",
      target: "bun",
      minify: false,
      external: ["@opencode-ai/plugin"],
    });

    if (!result.success || result.outputs.length === 0) {
      const logs = result.logs.map((log) => log.message).join("\n");
      throw new Error(
        `Failed to build embedded opencode plugin${logs ? `:\n${logs}` : "."}`,
      );
    }

    return await result.outputs[0]!.text();
  }
}

async function getEmbeddedPluginSource(): Promise<string> {
  embeddedPluginSourcePromise ??= loadEmbeddedPluginSource();
  return embeddedPluginSourcePromise;
}

async function prepareOpencodeDir(targetRoot: string): Promise<void> {
  const pluginsRoot = path.join(targetRoot, "plugins");
  const embeddedPlugin = await getEmbeddedPluginSource();
  await mkdir(pluginsRoot, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(targetRoot, ".gitignore"),
      embeddedOpencodeignore as string,
      "utf8",
    ),
    writeFile(
      path.join(targetRoot, "plugins", "boboddy.js"),
      embeddedPlugin,
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
}): Promise<void> {
  const targetRoot = path.join(input.workspacePath, ".opencode");
  const targetConfigPath = path.join(input.workspacePath, "opencode.jsonc");

  const baselineConfig = JSON.parse(
    JSON.stringify(parseJsoncConfig(embeddedOpencodeJsonc as string)),
  ) as Config;

  await prepareOpencodeDir(targetRoot);

  const mergedConfig = buildStepExecutionOpencodeConfig({
    baseConfig: baselineConfig,
    stepMcpServers: input.stepMcpServers,
    stepPlugins: input.stepPlugins,
    agentPromptText: input.agentPromptText,
  });
  await writeFile(
    targetConfigPath,
    `${JSON.stringify(mergedConfig, null, 2)}\n`,
    "utf8",
  );
}
