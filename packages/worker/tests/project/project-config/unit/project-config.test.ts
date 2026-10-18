import { describe, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { concurrentTest } from "../../../utils";
import { deriveProjectName } from "../../../../src/project/project-config/infra/fs-project-config-repo";
import { projectConfigRef } from "../../../../src/project/project-config/domain/project-config";
import { readProjectConfig } from "../../../../src/project/project-config/application/read-project-config";
import { writeProjectConfig } from "../../../../src/project/project-config/application/write-project-config";

describe("project config helpers", () => {
  concurrentTest("readProjectConfig returns null when file does not exist", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-init-config-"));
    try {
      const config = await readProjectConfig(tmpDir);
      expect(config).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  concurrentTest("readProjectConfig returns null when file has no project", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-init-config-"));
    try {
      mkdirSync(join(tmpDir, ".boboddy"));
      writeFileSync(join(tmpDir, ".boboddy", "boboddy.jsonc"), '{ "other": "value" }', "utf8");
      const config = await readProjectConfig(tmpDir);
      expect(config).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  concurrentTest("writeProjectConfig then readProjectConfig round-trips project", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-init-config-"));
    try {
      await writeProjectConfig("acme/web-app", tmpDir);
      const config = await readProjectConfig(tmpDir);
      expect(config).toEqual({ project: "acme/web-app" });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  concurrentTest(
    "writeProjectConfig keeps the other keys and drops a retired projectId",
    async () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-init-config-"));
      try {
        mkdirSync(join(tmpDir, ".boboddy"));
        writeFileSync(
          join(tmpDir, ".boboddy", "boboddy.jsonc"),
          '// mine\n{ "projectId": "old-uuid", "branchPrefix": "team", "baseWorkBranch": "dev" }',
          "utf8",
        );
        await writeProjectConfig("acme/web-app", tmpDir);
        const written = JSON.parse(
          readFileSync(join(tmpDir, ".boboddy", "boboddy.jsonc"), "utf8"),
        ) as unknown;
        expect(written).toEqual({
          project: "acme/web-app",
          branchPrefix: "team",
          baseWorkBranch: "dev",
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  concurrentTest("readProjectConfig handles JSONC with comments", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-init-config-"));
    try {
      mkdirSync(join(tmpDir, ".boboddy"));
      writeFileSync(
        join(tmpDir, ".boboddy", "boboddy.jsonc"),
        '// auto-generated\n{ "project": "acme/web-app" }',
        "utf8",
      );
      const config = await readProjectConfig(tmpDir);
      expect(config).toEqual({ project: "acme/web-app" });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  concurrentTest("projectConfigRef joins the owner username and slug", () => {
    expect(
      projectConfigRef({ name: "Web App", slug: "web-app", ownerUsername: "acme" }),
    ).toBe("acme/web-app");
  });

  concurrentTest("projectConfigRef fails when the owner has no username yet", () => {
    expect(() =>
      projectConfigRef({ name: "Web App", slug: "web-app", ownerUsername: null }),
    ).toThrow(/no owner username yet/u);
  });

  concurrentTest("deriveProjectName extracts name from HTTPS URL with .git suffix", () => {
    expect(deriveProjectName("https://github.com/user/my-repo.git")).toBe("my-repo");
  });

  concurrentTest("deriveProjectName extracts name from SSH URL", () => {
    expect(deriveProjectName("git@github.com:user/my-repo.git")).toBe("my-repo");
  });
});
