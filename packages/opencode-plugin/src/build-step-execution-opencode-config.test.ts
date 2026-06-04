import { beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "@opencode-ai/sdk";
import { buildStepExecutionOpencodeConfig } from "./build-step-execution-opencode-config";

describe("buildStepExecutionOpencodeConfig", () => {
  beforeAll(() => {
    // Ensure environment variables don't interfere with tests
    process.env["AGENT_DEFAULT_MODEL"] = "openapi/gpt-5.4";
  });

  test.concurrent(
    "preserves baseline config and enables required MCP tools only for step execution",
    () => {
      const baseConfig: Config = {
        $schema: "https://opencode.ai/config.json",
        permission: { bash: "allow" },
        model: "openapi/gpt-5.4",
        mcp: {
          datadog: {
            type: "local",
            command: ["npx", "-y", "@winor30/mcp-server-datadog@1.7.0"],
            enabled: true,
          },
        },
        tools: {
          "datadog*": false,
          "playwright*": false,
        },
        agent: {
          build: {
            description: "Baseline build agent",
            tools: {
              "datadog*": true,
            },
          },
        },
      };

      const config = buildStepExecutionOpencodeConfig({
        baseConfig,
        stepMcpServers: {
          playwright: {
            type: "local",
            command: ["npx", "-y", "@playwright/mcp@0.0.68"],
            enabled: true,
          },
        },
      });

      expect(config.permission).toEqual(baseConfig.permission);
      expect(config.mcp?.["datadog"]).toEqual(baseConfig.mcp?.["datadog"]);
      expect(config.mcp?.["playwright"]).toEqual({
        type: "local",
        command: ["npx", "-y", "@playwright/mcp@0.0.68"],
        enabled: true,
      });
      expect(config.tools?.["playwright*"]).toBe(false);
      expect(config.agent?.build?.tools?.["playwright*"]).toBe(true);
      expect(config.agent?.["step-execution"]).toBeUndefined();
      expect(config.agent?.build?.tools?.["datadog*"]).toBe(true);
    },
  );

  test.concurrent(
    "returns the baseline config unchanged when the step has no MCP overlay",
    () => {
      const baseConfig: Config = {
        model: "openapi/gpt-5.4",
        tools: {
          "playwright*": false,
        },
        agent: {
          build: {
            description: "Build",
          },
        },
      };

      const config = buildStepExecutionOpencodeConfig({
        baseConfig,
        stepMcpServers: null,
      });

      expect(config).toEqual(baseConfig);
    },
  );

  test.concurrent("merges step plugins into config.plugin", () => {
    const baseConfig: Config = {
      model: "openapi/gpt-5.4",
    };

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      stepPlugins: ["opencode-wakatime", ["@my-org/plugin", { key: "val" }]],
    });

    expect(config.plugin).toEqual([
      "opencode-wakatime",
      ["@my-org/plugin", { key: "val" }],
    ]);
  });

  test.concurrent("deduplicates plugins by package name when base already has entry", () => {
    const baseConfig: Config = {
      model: "openapi/gpt-5.4",
      plugin: ["opencode-wakatime"],
    };

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      stepPlugins: ["opencode-wakatime", "opencode-helicone-session"],
    });

    // opencode-wakatime already present — should not be duplicated
    expect(config.plugin).toEqual(["opencode-wakatime", "opencode-helicone-session"]);
  });

  test.concurrent("does not set config.plugin when step plugins are null", () => {
    const baseConfig: Config = {
      model: "openapi/gpt-5.4",
    };

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      stepPlugins: null,
    });

    expect(config.plugin).toBeUndefined();
  });

  test.concurrent("preserves existing base plugins when step adds new ones", () => {
    const baseConfig: Config = {
      model: "openapi/gpt-5.4",
      plugin: [["opencode-helicone-session", { project: "abc" }]],
    };

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      stepPlugins: ["opencode-wakatime"],
    });

    expect(config.plugin).toEqual([
      ["opencode-helicone-session", { project: "abc" }],
      "opencode-wakatime",
    ]);
  });
});
