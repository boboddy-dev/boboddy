import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildOpencodeContext } from "./build-opencode-context";

describe("buildOpencodeContext", () => {
  test("does NOT write .opencode/opencode.json (project repo stays untouched)", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    // The project-level opencode.json must NOT be written — the repo is clean.
    const configExists = await access(
      path.join(workspacePath, ".opencode", "opencode.json"),
    )
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(false);
  });

  test("does not write root opencode.jsonc either", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    const rootJsoncExists = await access(
      path.join(workspacePath, "opencode.jsonc"),
    )
      .then(() => true)
      .catch(() => false);
    expect(rootJsoncExists).toBe(false);
  });

  test("returns valid JSON in opencodeConfigContent", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    expect(() => {
      JSON.parse(opencodeConfigContent);
    }).not.toThrow();
  });

  test("opencodeConfigContent has no plugin key when no plugins provided", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    const config = JSON.parse(opencodeConfigContent) as { plugin?: unknown };
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

  test("stepPlugins are present in opencodeConfigContent.plugin (trusted, same-container)", async () => {
    // Single-container model: user/npm plugins run in the same container as the
    // workspace and are trusted, so they appear in the override config's plugin[].
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      stepPlugins: ["opencode-wakatime", ["@my-org/plugin", { key: "val" }]],
    });

    const config = JSON.parse(opencodeConfigContent) as {
      plugin?: unknown[];
    };

    expect(config.plugin).toContain("opencode-wakatime");
    expect(config.plugin).toContainEqual(["@my-org/plugin", { key: "val" }]);
  });

  test("step agent prompt appears in opencodeConfigContent agent.build.prompt", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      agentPromptText: "Execute the Boboddy step.",
    });

    const config = JSON.parse(opencodeConfigContent) as {
      agent?: { build?: { prompt?: string } };
    };

    expect(config.agent?.build?.prompt).toBe("Execute the Boboddy step.");
  });

  test("user's .opencode/opencode.json is NOT merged into opencodeConfigContent (loaded natively by OpenCode at #4)", async () => {
    // The project config is left for OpenCode to load natively via its own
    // precedence chain. Boboddy's override layer (OPENCODE_CONFIG_CONTENT)
    // should NOT contain user-config keys like an MCP server declared only in
    // the project's opencode.json.
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const opencodeDir = path.join(workspacePath, ".opencode");
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      path.join(opencodeDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          postgres: {
            type: "local",
            command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
            enabled: true,
          },
        },
      }),
      "utf8",
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    const config = JSON.parse(opencodeConfigContent) as {
      mcp?: Record<string, unknown>;
    };

    // The postgres MCP server from the project config must NOT be in the
    // override layer — OpenCode loads it natively via project config (#4).
    expect(config.mcp?.["postgres"]).toBeUndefined();
  });

  test("step MCP servers ARE present in opencodeConfigContent", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: {
        playwright: {
          type: "local",
          command: ["npx", "-y", "@playwright/mcp@0.0.68"],
          enabled: true,
        },
      },
    });

    const config = JSON.parse(opencodeConfigContent) as {
      mcp?: Record<string, unknown>;
    };

    expect(config.mcp?.["playwright"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@0.0.68"],
      enabled: true,
    });
  });

  test("Boboddy permission block is in opencodeConfigContent", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    const config = JSON.parse(opencodeConfigContent) as {
      permission?: Record<string, unknown>;
    };

    // Permission block from embedded opencode.jsonc must be present in the
    // override layer so it wins as the security boundary at precedence #6.
    expect(config.permission).toBeDefined();
    expect(config.permission?.["boboddy*"]).toBe("allow");
  });

  test(".opencode/tools/ left in place — trusted and loaded in-container", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    // Create a .opencode/tools/ dir with a user tool file
    const toolsDir = path.join(workspacePath, ".opencode", "tools");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(
      path.join(toolsDir, "my-tool.ts"),
      "export const myTool = {};",
      "utf8",
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    // Tools dir and file must still exist — they are trusted and load directly.
    const toolsExists = await access(toolsDir)
      .then(() => true)
      .catch(() => false);
    expect(toolsExists).toBe(true);

    const toolFileExists = await access(path.join(toolsDir, "my-tool.ts"))
      .then(() => true)
      .catch(() => false);
    expect(toolFileExists).toBe(true);
  });

  test(".opencode/tools/ absent — no error", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    // Should complete without error even when tools dir doesn't exist
    const result = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });
    expect(result).toBeDefined();
  });

  test("user plugin files in .opencode/plugins/ are left in place (trusted)", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    // Pre-create a plugins dir with a user plugin file
    const pluginsDir = path.join(workspacePath, ".opencode", "plugins");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(
      path.join(pluginsDir, "user-plugin.js"),
      "export default {};",
      "utf8",
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    // User file must remain — trusted, loaded directly in-container.
    const userPluginExists = await access(
      path.join(pluginsDir, "user-plugin.js"),
    )
      .then(() => true)
      .catch(() => false);
    expect(userPluginExists).toBe(true);

    // boboddy.js (the embedded trusted plugin) is written alongside it.
    const boboddyExists = await access(path.join(pluginsDir, "boboddy.js"))
      .then(() => true)
      .catch(() => false);
    expect(boboddyExists).toBe(true);
  });

  test("pre-existing user .opencode/opencode.json is NOT overwritten", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const opencodeDir = path.join(workspacePath, ".opencode");
    await mkdir(opencodeDir, { recursive: true });
    const userConfigPath = path.join(opencodeDir, "opencode.json");
    const originalContent = JSON.stringify({ model: "user-model" });
    await writeFile(userConfigPath, originalContent, "utf8");

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    // The file must be byte-for-byte unchanged.
    const afterContent = await readFile(userConfigPath, "utf8");
    expect(afterContent).toBe(originalContent);
  });

  test("providerOverride is absent by default (no provider key in output)", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    const config = JSON.parse(opencodeConfigContent) as {
      provider?: unknown;
    };
    expect(config.provider).toBeUndefined();
  });

  test("providerOverride is merged into opencodeConfigContent.provider", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      providerOverride: {
        provider: {
          anthropic: {
            options: { baseURL: "http://fake-ai:9999", apiKey: "fake-key" },
            models: {
              "boboddy-healthchecker-model": {
                name: "Boboddy Health Checker (internal)",
              },
            },
          },
        },
      },
    });

    const config = JSON.parse(opencodeConfigContent) as {
      provider?: Record<string, unknown>;
    };

    expect(config.provider?.["anthropic"]).toEqual({
      options: { baseURL: "http://fake-ai:9999", apiKey: "fake-key" },
      models: {
        "boboddy-healthchecker-model": {
          name: "Boboddy Health Checker (internal)",
        },
      },
    });
  });

  test("providerOverride of null/undefined leaves rest of config identical to omitting it", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const withoutField = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });
    const withNull = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      providerOverride: null,
    });

    expect(withNull.opencodeConfigContent).toBe(
      withoutField.opencodeConfigContent,
    );
  });
});
