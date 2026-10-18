import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectConfig,
  parseProjectRef,
} from "../src/defaults/project-config";

describe("parseProjectRef", () => {
  test.each([
    ["acme/web-app", { owner: "acme", slug: "web-app" }],
    ["a-b/x", { owner: "a-b", slug: "x" }],
  ])("accepts %s", (ref, expected) => {
    expect(parseProjectRef(ref)).toEqual(expected);
  });

  test.each([
    "web-app",
    "acme/web-app/extra",
    "ab/web-app",
    `${"a".repeat(33)}/web-app`,
    `acme/${"a".repeat(65)}`,
    "Acme/web-app",
    "acme/web_app",
    "acme/-web",
    "acme/web--app",
    "acme/",
    "/web-app",
    "019a0000-0000-7000-8000-000000000000",
  ])("rejects %s", (ref) => {
    expect(parseProjectRef(ref)).toBeNull();
  });
});

function writeConfig(contents: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), "boboddy-project-config-"));
  mkdirSync(join(rootDir, ".boboddy"), { recursive: true });
  writeFileSync(join(rootDir, ".boboddy", "boboddy.jsonc"), contents);
  return rootDir;
}

describe("loadProjectConfig", () => {
  test("parses project with no branchPrefix", async () => {
    const dir = writeConfig(JSON.stringify({ project: "acme/web-app" }));
    try {
      const config = await loadProjectConfig(dir);
      expect(config).toEqual({ project: "acme/web-app" });
      expect(config?.branchPrefix).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses a string branchPrefix", async () => {
    const dir = writeConfig(
      JSON.stringify({ project: "acme/web-app", branchPrefix: "myteam" }),
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
      JSON.stringify({ project: "acme/web-app", baseWorkBranch: "feat/cool" }),
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
      JSON.stringify({ project: "acme/web-app", baseWorkBranch: 123 }),
    );
    try {
      expect(await loadProjectConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a non-string branchPrefix (returns null)", async () => {
    const dir = writeConfig(
      JSON.stringify({ project: "acme/web-app", branchPrefix: 123 }),
    );
    try {
      expect(await loadProjectConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a legacy projectId-only config (returns null)", async () => {
    const dir = writeConfig(JSON.stringify({ projectId: "proj-1" }));
    try {
      expect(await loadProjectConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a project that is not owner/slug (returns null)", async () => {
    const dir = writeConfig(JSON.stringify({ project: "web-app" }));
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
