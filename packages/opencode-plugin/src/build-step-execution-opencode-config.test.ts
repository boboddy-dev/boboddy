import { beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "@opencode-ai/sdk";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";
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
    const stepPlugins: OpenCodePlugins = [
      "opencode-wakatime",
      ["@my-org/plugin", { key: "val" }],
    ];

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      stepPlugins: [...stepPlugins],
    });

    expect(config.plugin as unknown).toEqual([
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
    const baseConfig = {
      model: "openapi/gpt-5.4",
      plugin: [["opencode-helicone-session", { project: "abc" }]],
    } as unknown as Config;

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      stepPlugins: ["opencode-wakatime"],
    });

    expect(config.plugin as unknown).toEqual([
      ["opencode-helicone-session", { project: "abc" }],
      "opencode-wakatime",
    ]);
  });

  test.concurrent("userConfig MCP servers are merged into output", () => {
    const baseConfig: Config = { model: "openapi/gpt-5.4" };
    const userConfig: Config = {
      mcp: {
        postgres: {
          type: "local",
          command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
          enabled: true,
          environment: { DATABASE_URI: "{env:DATABASE_URI}" },
        },
      },
    };

    const config = buildStepExecutionOpencodeConfig({ baseConfig, userConfig });

    expect(config.mcp?.["postgres"]).toEqual({
      type: "local",
      command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
      enabled: true,
      environment: { DATABASE_URI: "{env:DATABASE_URI}" },
    });
  });

  test.concurrent("step MCP servers override same-named userConfig MCP servers", () => {
    const baseConfig: Config = { model: "openapi/gpt-5.4" };
    const userConfig: Config = {
      mcp: {
        postgres: {
          type: "local",
          command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
          enabled: true,
        },
      },
    };

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      userConfig,
      stepMcpServers: {
        postgres: {
          type: "local",
          command: ["uvx", "postgres-mcp", "--access-mode=read-write"],
          enabled: true,
        },
      },
    });

    expect((config.mcp?.["postgres"] as { command?: string[] }).command).toEqual([
      "uvx",
      "postgres-mcp",
      "--access-mode=read-write",
    ]);
  });

  test.concurrent("userConfig plugins are merged and deduplicated with step plugins", () => {
    const baseConfig: Config = { model: "openapi/gpt-5.4" };
    const userConfig = { plugin: ["@datadog/opencode-plugin"] } as Config;

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      userConfig,
      stepPlugins: ["@datadog/opencode-plugin", "opencode-wakatime"],
    });

    expect(config.plugin).toEqual(["@datadog/opencode-plugin", "opencode-wakatime"]);
  });

  test.concurrent("Boboddy embedded permission wins over userConfig permission", () => {
    const baseConfig = {
      model: "openapi/gpt-5.4",
      permission: { "*": "allow", "boboddy*": "allow", "question": "deny" },
    } as Config;
    const userConfig = { permission: { "*": "deny" } } as Config;

    const config = buildStepExecutionOpencodeConfig({ baseConfig, userConfig });

    expect(config.permission).toEqual(baseConfig.permission);
  });

  test.concurrent("userConfig: null leaves output unchanged", () => {
    const baseConfig: Config = {
      model: "openapi/gpt-5.4",
      mcp: { playwright: { type: "local", command: ["npx", "@playwright/mcp"], enabled: true } },
    };

    const config = buildStepExecutionOpencodeConfig({
      baseConfig,
      userConfig: null,
      stepMcpServers: null,
    });

    expect(config.mcp?.["playwright"]).toEqual(baseConfig.mcp?.["playwright"]);
  });

  test.concurrent("userConfig top-level fields (e.g. model) override baseline", () => {
    const baseConfig: Config = { model: "openapi/gpt-5.4" };
    const userConfig: Config = { model: "anthropic/claude-opus-4" };

    // AGENT_DEFAULT_MODEL is set in beforeAll so it takes final precedence;
    // clear it temporarily to test user model passthrough
    const saved = process.env["AGENT_DEFAULT_MODEL"];
    delete process.env["AGENT_DEFAULT_MODEL"];

    const config = buildStepExecutionOpencodeConfig({ baseConfig, userConfig });

    process.env["AGENT_DEFAULT_MODEL"] = saved;

    expect(config.model).toBe("anthropic/claude-opus-4");
  });
});
