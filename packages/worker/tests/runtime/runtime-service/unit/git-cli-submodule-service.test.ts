/**
 * Integration tests for {@link GitCliSubmoduleService} against REAL temp git
 * repos. A local-path submodule is added to a superproject; local-file
 * submodule transport requires `protocol.file.allow=always` on modern git, so
 * the setup passes it per-invocation. This mirrors the real-temp-repo style of
 * git-cli-commit-push-service.test.ts. No Docker is used.
 *
 * Each test builds and tears down its own fixture inline (via `setupFixture`)
 * so tests share no mutable state and can run under `test.concurrent`.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCliSubmoduleService } from "../../../../src/runtime/runtime-service/infra/git-cli-submodule-service";
import { git, writeRepoFile } from "./git-test-fixtures";

async function initRepoWithCommit(repo: string, name: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", `${name}@boboddy.dev`]);
  await git(repo, ["config", "user.name", name]);
  await writeRepoFile(repo, "README.md", `${name}\n`);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", "init"]);
}

async function setupFixture(): Promise<{
  root: string;
  superproject: string;
  submoduleSource: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-submodule-"));
  const superproject = path.join(root, "superproject");
  const submoduleSource = path.join(root, "submodule-src");

  await initRepoWithCommit(superproject, "Super");
  await initRepoWithCommit(submoduleSource, "Sub");

  return { root, superproject, submoduleSource };
}

describe("GitCliSubmoduleService", () => {
  const service = new GitCliSubmoduleService();

  test.concurrent(
    "detects an added submodule as initialized:true",
    async () => {
      const { root, superproject, submoduleSource } = await setupFixture();
      try {
        await git(superproject, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          submoduleSource,
          "vendor/dep",
        ]);
        await git(superproject, [
          "commit",
          "--no-gpg-sign",
          "-m",
          "add submodule",
        ]);

        const result = await service.detectSubmodules({
          workspacePath: superproject,
        });

        expect(result).toEqual([{ path: "vendor/dep", initialized: true }]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent("returns [] for a repo with no submodules", async () => {
    const { root, superproject } = await setupFixture();
    try {
      const result = await service.detectSubmodules({
        workspacePath: superproject,
      });
      expect(result).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.concurrent(
    "reports initialized:false for an uninitialized submodule",
    async () => {
      const { root, superproject, submoduleSource } = await setupFixture();
      try {
        await git(superproject, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          submoduleSource,
          "vendor/dep",
        ]);
        await git(superproject, [
          "commit",
          "--no-gpg-sign",
          "-m",
          "add submodule",
        ]);

        // Fresh clone WITHOUT --recurse-submodules leaves the submodule uninitialized.
        const fresh = path.join(root, "fresh");
        await git(root, [
          "-c",
          "protocol.file.allow=always",
          "clone",
          superproject,
          fresh,
        ]);

        const result = await service.detectSubmodules({
          workspacePath: fresh,
        });
        expect(result).toEqual([{ path: "vendor/dep", initialized: false }]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
