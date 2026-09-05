/**
 * Unit tests for {@link GitCliCloneService} against REAL local git repos (no
 * network access). Mirrors the fixture style used across the other
 * git-cli-*-service suites: a bare "remote" repo with an initial commit,
 * cloned via a local filesystem path (`file://`-free — plain path — so no
 * network stack is exercised at all).
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GitCliCloneService } from "../../../../src/runtime/runtime-service/infra/git-cli-clone-service";
import { git, writeRepoFile } from "./git-test-fixtures";

async function setupRemoteFixture(): Promise<{
  root: string;
  remote: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-clone-service-"));
  const remote = path.join(root, "remote.git");

  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare", "-b", "main"]);

  const seed = path.join(root, "seed");
  await git(root, ["clone", remote, seed]);
  await git(seed, ["config", "user.email", "seed@boboddy.dev"]);
  await git(seed, ["config", "user.name", "Seed"]);
  await writeRepoFile(seed, "README.md", "hello\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--no-gpg-sign", "-m", "init"]);
  await git(seed, ["push", "origin", "main"]);

  return { root, remote };
}

describe("GitCliCloneService", () => {
  const service = new GitCliCloneService();

  test.concurrent(
    "clones the repository into the workspace and resolves the default branch",
    async () => {
      const { root, remote } = await setupRemoteFixture();
      const workspacePath = path.join(root, "workspace");
      try {
        const result = await service.cloneRepository({
          gitUrl: remote,
          workspacePath,
        });

        expect(result.resolvedBranch).toBe("main");
        expect(await git(workspacePath, ["log", "--oneline"])).toContain(
          "init",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.concurrent(
    "wraps failures with a descriptive error instead of hanging or throwing raw",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "git-clone-service-failure-"),
      );
      const workspacePath = path.join(root, "workspace");
      try {
        expect(
          service.cloneRepository({
            gitUrl: path.join(root, "does-not-exist.git"),
            workspacePath,
          }),
        ).rejects.toThrow("Failed to clone runtime session repository");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
