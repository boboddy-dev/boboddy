/**
 * Unit tests for {@link findGitRoot} and {@link resolveGitRepository}.
 *
 * `findGitRoot` is exercised against plain directories/files on disk (no real
 * git needed) since it only has to recognize a `.git` entry, mirroring
 * `ensure-devcontainer.test.ts`'s style. `resolveGitRepository` additionally
 * shells out for the `origin` remote, so its tests use a real temp git repo,
 * mirroring `git-cli-source-branch-port.test.ts`'s style.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigurationError } from "../../../../src/lib/errors";
import {
  findGitRoot,
  resolveGitRepository,
} from "../../../../src/project/project-setup/application/resolve-git-repository";
import { concurrentTest } from "../../../utils";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

describe("findGitRoot", () => {
  concurrentTest(
    "returns the directory itself when it has a .git directory",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "find-git-root-"));
      try {
        await mkdir(path.join(root, ".git"));
        expect(await findGitRoot(root)).toBe(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "walks up from a nested subdirectory to the repo root",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "find-git-root-"));
      try {
        await mkdir(path.join(root, ".git"));
        const nested = path.join(root, "a", "b", "c");
        await mkdir(nested, { recursive: true });
        expect(await findGitRoot(nested)).toBe(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "treats a .git file (submodule) the same as a .git directory",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "find-git-root-"));
      try {
        await writeFile(
          path.join(root, ".git"),
          "gitdir: ../.git/modules/x\n",
          "utf8",
        );
        expect(await findGitRoot(root)).toBe(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "stops at the nearest .git, not a superproject's further up (submodule-safe)",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "find-git-root-"));
      try {
        // Superproject root.
        await mkdir(path.join(root, ".git"));
        // Submodule with its own .git file, nested inside the superproject.
        const submodule = path.join(root, "vendor", "sub");
        await mkdir(submodule, { recursive: true });
        await writeFile(
          path.join(submodule, ".git"),
          "gitdir: ../../.git/modules/vendor/sub\n",
          "utf8",
        );
        const deep = path.join(submodule, "deep");
        await mkdir(deep);

        expect(await findGitRoot(deep)).toBe(submodule);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "returns null when no .git exists up to the filesystem root",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "find-git-root-"));
      try {
        // `os.tmpdir()` (and everything above it) is not expected to sit inside
        // a git repository on any machine this test runs on.
        expect(await findGitRoot(root)).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("resolveGitRepository", () => {
  // Not `concurrentTest`: each test needs its own isolated tmp root, and
  // `beforeEach`/`afterEach` here share mutable `root`/`repo` bindings the
  // same way `git-cli-source-branch-port.test.ts` does, so tests run in
  // sequence rather than racing each other's setup/teardown.
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "resolve-git-repo-"));
    repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, [
      "remote",
      "add",
      "origin",
      "git@github.com:example/repo.git",
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("resolves the repo root and origin remote from the root itself", async () => {
    expect(await resolveGitRepository(repo)).toEqual({
      repoRoot: repo,
      remoteUrl: "git@github.com:example/repo.git",
    });
  });

  test("resolves the same repo root and remote from a nested subdirectory", async () => {
    const nested = path.join(repo, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(await resolveGitRepository(nested)).toEqual({
      repoRoot: repo,
      remoteUrl: "git@github.com:example/repo.git",
    });
  });

  test("throws a ConfigurationError outside any git repository", async () => {
    const outside = path.join(root, "not-a-repo");
    await mkdir(outside, { recursive: true });
    expect(resolveGitRepository(outside)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  test("throws a ConfigurationError when the repo has no origin remote", async () => {
    const noOrigin = path.join(root, "no-origin");
    await mkdir(noOrigin, { recursive: true });
    await git(noOrigin, ["init", "-b", "main"]);
    expect(resolveGitRepository(noOrigin)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
