import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildOpencodeContext, USER_TOOLS_MCP_SERVER_NAME } from "./build-opencode-context";

const CONFIG_PATH = (workspacePath: string) =>
  path.join(workspacePath, ".opencode", "opencode.json");

async function writeUserConfig(
  workspacePath: string,
  config: unknown,
): Promise<void> {
  const opencodeDir = path.join(workspacePath, ".opencode");
  await mkdir(opencodeDir, { recursive: true });
  await writeFile(
    path.join(opencodeDir, "opencode.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

describe("buildOpencodeContext", () => {
  test("writes config to .opencode/opencode.json (not root opencode.jsonc)", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    const configExists = await access(CONFIG_PATH(workspacePath))
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(true);

    const rootJsoncExists = await access(
      path.join(workspacePath, "opencode.jsonc"),
    )
      .then(() => true)
      .catch(() => false);
    expect(rootJsoncExists).toBe(false);
  });

  test("writes config without plugin reference when no plugins provided", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { plugin?: unknown };

    expect(config.plugin).toBeUndefined();
  });

  test("does not create .opencode/package.json", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    const packageJsonExists = await access(
      path.join(workspacePath, ".opencode", "package.json"),
    )
      .then(() => true)
      .catch(() => false);

    expect(packageJsonExists).toBe(false);
  });

  test("creates .opencode/plugins/ directory", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    const pluginsDirExists = await access(
      path.join(workspacePath, ".opencode", "plugins"),
    )
      .then(() => true)
      .catch(() => false);
    expect(pluginsDirExists).toBe(true);
  });

  test("writes step plugins into config.plugin", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      stepPlugins: ["opencode-wakatime", ["@my-org/plugin", { key: "val" }]],
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { plugin?: unknown };

    expect(config.plugin).toEqual([
      "opencode-wakatime",
      ["@my-org/plugin", { key: "val" }],
    ]);
  });

  test("writes the step agent prompt into agent.build.prompt", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      agentPromptText: "Execute the Boboddy step.",
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { agent?: { build?: { prompt?: string } } };

    expect(config.agent?.build?.prompt).toBe("Execute the Boboddy step.");
  });

  test("merges user MCP servers from .opencode/opencode.json into output", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await writeUserConfig(workspacePath, {
      mcp: {
        postgres: {
          type: "local",
          command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
          enabled: true,
          environment: { DATABASE_URI: "{env:DATABASE_URI}" },
        },
      },
    });

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { mcp?: Record<string, unknown> };

    expect(config.mcp?.["postgres"]).toEqual({
      type: "local",
      command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
      enabled: true,
      environment: { DATABASE_URI: "{env:DATABASE_URI}" },
    });
  });

  test("step MCP servers override same-named user MCP servers", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await writeUserConfig(workspacePath, {
      mcp: {
        postgres: {
          type: "local",
          command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
          enabled: true,
          environment: { DATABASE_URI: "{env:DATABASE_URI}" },
        },
      },
    });

    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: {
        postgres: {
          type: "local",
          command: ["uvx", "postgres-mcp", "--access-mode=read-write"],
          enabled: true,
        },
      },
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { mcp?: Record<string, unknown> };

    expect((config.mcp?.["postgres"] as { command?: string[] })?.command).toEqual([
      "uvx",
      "postgres-mcp",
      "--access-mode=read-write",
    ]);
  });

  test("user plugins are preserved and deduplicated with step plugins", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await writeUserConfig(workspacePath, {
      plugin: ["@datadog/opencode-plugin"],
    });

    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      stepPlugins: ["@datadog/opencode-plugin", "opencode-wakatime"],
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { plugin?: unknown };

    expect(config.plugin).toEqual(["@datadog/opencode-plugin", "opencode-wakatime"]);
  });

  test("behaves identically when no user config file exists", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    // No user config written — fresh workspace
    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      agentPromptText: "Do the thing.",
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { agent?: { build?: { prompt?: string } }; mcp?: unknown };

    expect(config.agent?.build?.prompt).toBe("Do the thing.");
    expect(config.mcp).toBeDefined();
  });

  test("returns the final merged Config object", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await writeUserConfig(workspacePath, {
      mcp: {
        postgres: {
          type: "local",
          command: ["uvx", "postgres-mcp"],
          enabled: true,
        },
      },
    });

    const result = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    expect((result.mcp as Record<string, unknown> | undefined)?.["postgres"]).toBeDefined();
  });

  test("injects boboddy-user-tools remote MCP server when userToolsMcpUrl is provided", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const mcpUrl = "http://devcontainer:40751/mcp";
    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      userToolsMcpUrl: mcpUrl,
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { mcp?: Record<string, unknown> };

    const bridgeServer = config.mcp?.[USER_TOOLS_MCP_SERVER_NAME] as
      | { type: string; url: string; enabled: boolean }
      | undefined;
    expect(bridgeServer).toBeDefined();
    expect(bridgeServer?.type).toBe("remote");
    expect(bridgeServer?.url).toBe(mcpUrl);
    expect(bridgeServer?.enabled).toBe(true);
  });

  test("boboddy-user-tools is gated for the build agent when userToolsMcpUrl is provided", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      userToolsMcpUrl: "http://devcontainer:40751/mcp",
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as {
      tools?: Record<string, unknown>;
      agent?: { build?: { tools?: Record<string, unknown> } };
    };

    // Tool prefix is disabled globally
    expect(config.tools?.[`${USER_TOOLS_MCP_SERVER_NAME}*`]).toBe(false);
    // Tool prefix is enabled for the build agent
    expect(config.agent?.build?.tools?.[`${USER_TOOLS_MCP_SERVER_NAME}*`]).toBe(true);
  });

  test("no boboddy-user-tools entry when userToolsMcpUrl is not provided", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { mcp?: Record<string, unknown> };

    expect(config.mcp?.[USER_TOOLS_MCP_SERVER_NAME]).toBeUndefined();
  });

  test("user/npm plugin entries are NOT written to config.plugin when stepPlugins is null", async () => {
    // This verifies the security invariant: user plugins go through the MCP host,
    // not into the AI container's config.plugin[] array.
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      // stepPlugins intentionally omitted (null) — user plugins must not reach the AI config
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { plugin?: unknown };

    // No plugin[] array in AI config — user tools come via MCP host
    expect(config.plugin).toBeUndefined();
  });

  test("Boboddy permission block is preserved in output when userToolsMcpUrl is provided", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      userToolsMcpUrl: "http://devcontainer:40751/mcp",
    });

    const config = JSON.parse(
      await readFile(CONFIG_PATH(workspacePath), "utf8"),
    ) as { permission?: Record<string, unknown> };

    // Permission block from embedded opencode.jsonc must be present
    expect(config.permission).toBeDefined();
    expect(config.permission?.["boboddy*"]).toBe("allow");
  });
});
