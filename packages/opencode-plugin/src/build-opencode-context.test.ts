import { mkdtemp, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildOpencodeContext } from "./build-opencode-context";

describe("buildOpencodeContext", () => {
  test("writes opencode.jsonc without plugin reference", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    const config = JSON.parse(
      await readFile(path.join(workspacePath, "opencode.jsonc"), "utf8"),
    ) as { plugin?: unknown };

    expect(config.plugin).toBeUndefined();
  });

  test("creates .opencode/package.json with only plugin sdk dep", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "build-opencode-context-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    const runtimePackageJson = JSON.parse(
      await readFile(
        path.join(workspacePath, ".opencode", "package.json"),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(runtimePackageJson.dependencies ?? {})).toEqual([
      "@opencode-ai/plugin",
    ]);
    expect(runtimePackageJson.dependencies).not.toHaveProperty("@boboddy/core");
    expect(runtimePackageJson.dependencies).not.toHaveProperty("@boboddy/sdk");
    expect(runtimePackageJson.dependencies).not.toHaveProperty("ajv");
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
      await readFile(path.join(workspacePath, "opencode.jsonc"), "utf8"),
    ) as {
      agent?: {
        build?: {
          prompt?: string;
        };
      };
    };

    expect(config.agent?.build?.prompt).toBe("Execute the Boboddy step.");
  });
});
