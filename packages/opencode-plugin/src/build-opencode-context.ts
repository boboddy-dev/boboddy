import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "@opencode-ai/sdk";
import type { OpenCodeMcpServers } from "@boboddy/sdk/opencode-mcp";
import { parseJsonc } from "@boboddy/sdk/jsonc";
import { buildStepExecutionOpencodeConfig } from "./build-step-execution-opencode-config";
import embeddedOpencodeJsonc from "../opencode.jsonc" with { type: "text" };
import embeddedOpencodeignore from "../opencodeignore.txt" with { type: "text" };
import embeddedPlugin from "../dist/plugin.js" with { type: "text" };
import packageJson from "../package.json" with { type: "json" };

const PLUGIN_SDK_VERSION =
  (packageJson as unknown as { dependencies?: Record<string, string> })
    .dependencies?.["@opencode-ai/plugin"] ?? "*";

function parseJsoncConfig(content: string): Config {
  return parseJsonc(content) as Config;
}

async function prepareOpencodeDir(targetRoot: string): Promise<void> {
  await mkdir(path.join(targetRoot, "plugins"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(targetRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@boboddy/opencode-plugin-runtime",
          private: true,
          type: "module",
          dependencies: {
            "@opencode-ai/plugin": PLUGIN_SDK_VERSION,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      path.join(targetRoot, ".gitignore"),
      embeddedOpencodeignore as string,
      "utf8",
    ),
    writeFile(
      path.join(targetRoot, "plugins", "boboddy.js"),
      embeddedPlugin as unknown as string,
      "utf8",
    ),
  ]);
}

export async function buildOpencodeContext(input: {
  workspacePath: string;
  stepMcpServers?: OpenCodeMcpServers | null | undefined;
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
    agentPromptText: input.agentPromptText,
  });
  await writeFile(
    targetConfigPath,
    `${JSON.stringify(mergedConfig, null, 2)}\n`,
    "utf8",
  );
}
