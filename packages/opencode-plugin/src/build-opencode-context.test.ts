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

  test("opencodeConfigContent has no plugins key when the baseline has none", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    const config = JSON.parse(opencodeConfigContent) as { plugins?: unknown };
    expect(config.plugins).toBeUndefined();
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

  test("step agent prompt appears in opencodeConfigContent agents.build.system", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      agentPromptText: "Execute the Boboddy step.",
    });

    const config = JSON.parse(opencodeConfigContent) as {
      agents?: { build?: { system?: string } };
    };

    expect(config.agents?.build?.system).toBe("Execute the Boboddy step.");
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
          servers: {
            postgres: {
              type: "local",
              command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
            },
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
      mcp?: { servers?: Record<string, unknown> };
    };

    // The postgres MCP server from the project config must NOT be in the
    // override layer — OpenCode loads it natively via project config (#4).
    expect(config.mcp?.servers?.["postgres"]).toBeUndefined();
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
        },
      },
    });

    const config = JSON.parse(opencodeConfigContent) as {
      mcp?: { servers?: Record<string, unknown> };
    };

    expect(config.mcp?.servers?.["playwright"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@0.0.68"],
      codemode: false,
    });
  });

  test("Boboddy permission rules are in opencodeConfigContent", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    const config = JSON.parse(opencodeConfigContent) as {
      permissions?: unknown[];
    };

    // Rules from the embedded opencode.jsonc must be present in the override
    // layer so they are appended last and win as the security boundary.
    expect(config.permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "boboddy*", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "deny" },
    ]);
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

  test("providerOverride is absent by default (no providers key in output)", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
    });

    const config = JSON.parse(opencodeConfigContent) as {
      providers?: unknown;
    };
    expect(config.providers).toBeUndefined();
  });

  test("providerOverride is merged into opencodeConfigContent.providers", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    const fakeProvider = {
      package: "aisdk:@ai-sdk/anthropic",
      name: "Boboddy Health Checker (internal)",
      settings: { baseURL: "http://fake-ai:9999", apiKey: "fake-key" },
      models: {
        "boboddy-healthchecker-model": {
          name: "Boboddy Health Checker (internal)",
        },
      },
    };

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      providerOverride: {
        providers: { "boboddy-healthchecker": fakeProvider },
      },
    });

    const config = JSON.parse(opencodeConfigContent) as {
      providers?: Record<string, unknown>;
    };

    expect(config.providers?.["boboddy-healthchecker"]).toEqual(fakeProvider);
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
