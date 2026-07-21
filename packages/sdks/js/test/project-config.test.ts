import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig } from "../src/defaults/project-config";

function writeConfig(contents: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), "boboddy-project-config-"));
  mkdirSync(join(rootDir, ".boboddy"), { recursive: true });
  writeFileSync(join(rootDir, ".boboddy", "boboddy.jsonc"), contents);
  return rootDir;
}

describe("loadProjectConfig", () => {
  test("parses projectId with no branchPrefix", async () => {
    const dir = writeConfig(JSON.stringify({ projectId: "proj-1" }));
    try {
      const config = await loadProjectConfig(dir);
      expect(config).toEqual({ projectId: "proj-1" });
      expect(config?.branchPrefix).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses a string branchPrefix", async () => {
    const dir = writeConfig(
      JSON.stringify({ projectId: "proj-1", branchPrefix: "myteam" }),
    );
    try {
      const config = await loadProjectConfig(dir);
      expect(config?.branchPrefix).toBe("myteam");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses a string baseWorkBranch", async () => {
    const dir = writeConfig(
      JSON.stringify({ projectId: "proj-1", baseWorkBranch: "feat/cool" }),
    );
    try {
      const config = await loadProjectConfig(dir);
      expect(config?.baseWorkBranch).toBe("feat/cool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a non-string baseWorkBranch (returns null)", async () => {
    const dir = writeConfig(
      JSON.stringify({ projectId: "proj-1", baseWorkBranch: 123 }),
    );
    try {
      expect(await loadProjectConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a non-string branchPrefix (returns null)", async () => {
    const dir = writeConfig(
      JSON.stringify({ projectId: "proj-1", branchPrefix: 123 }),
    );
    try {
      expect(await loadProjectConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the file is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boboddy-project-config-empty-"));
    try {
      expect(await loadProjectConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
