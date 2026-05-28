import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPushDefaults } from "../src/defaults/load-push-defaults";

describe("loadPushDefaults", () => {
  const savedEnv = {
    BOBODDY_BASE_URL: process.env["BOBODDY_BASE_URL"],
    BOBODDY_PROJECT_ID: process.env["BOBODDY_PROJECT_ID"],
    BOBODDY_ACCESS_TOKEN: process.env["BOBODDY_ACCESS_TOKEN"],
  };

  beforeEach(() => {
    delete process.env["BOBODDY_BASE_URL"];
    delete process.env["BOBODDY_PROJECT_ID"];
    delete process.env["BOBODDY_ACCESS_TOKEN"];
  });

  afterEach(() => {
    if (savedEnv.BOBODDY_BASE_URL === undefined) {
      delete process.env["BOBODDY_BASE_URL"];
    } else {
      process.env["BOBODDY_BASE_URL"] = savedEnv.BOBODDY_BASE_URL;
    }
    if (savedEnv.BOBODDY_PROJECT_ID === undefined) {
      delete process.env["BOBODDY_PROJECT_ID"];
    } else {
      process.env["BOBODDY_PROJECT_ID"] = savedEnv.BOBODDY_PROJECT_ID;
    }
    if (savedEnv.BOBODDY_ACCESS_TOKEN === undefined) {
      delete process.env["BOBODDY_ACCESS_TOKEN"];
    } else {
      process.env["BOBODDY_ACCESS_TOKEN"] = savedEnv.BOBODDY_ACCESS_TOKEN;
    }
  });

  test("env vars take precedence over discovered values", async () => {
    process.env["BOBODDY_BASE_URL"] = "https://override.example.com";
    process.env["BOBODDY_PROJECT_ID"] = "env-proj";
    process.env["BOBODDY_ACCESS_TOKEN"] = "env-token";

    const dir = mkdtempSync(join(tmpdir(), "boboddy-defaults-env-"));
    try {
      const result = await loadPushDefaults({ dir });
      expect(result.baseUrl).toBe("https://override.example.com");
      expect(result.projectId).toBe("env-proj");
      expect(result.accessToken).toBe("env-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("walks ancestor dirs to find .boboddy/boboddy.jsonc when env is unset", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "boboddy-defaults-walk-"));
    const childDir = join(rootDir, "deeply", "nested");
    mkdirSync(childDir, { recursive: true });

    mkdirSync(join(rootDir, ".boboddy"), { recursive: true });
    writeFileSync(
      join(rootDir, ".boboddy", "boboddy.jsonc"),
      JSON.stringify({ projectId: "walked-proj" }),
    );

    try {
      const result = await loadPushDefaults({ dir: childDir });
      expect(result.projectId).toBe("walked-proj");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("returns undefined projectId when no config is found and no env is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boboddy-defaults-empty-"));
    try {
      const result = await loadPushDefaults({ dir });
      expect(result.projectId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
