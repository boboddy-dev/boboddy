import { describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  REPOSITORY_TASK_LABEL,
  reportResolvedRepository,
  strayProjectConfigMessage,
  warnAboutStrayProjectConfig,
} from "../src/lib/init-repository-resolution";
import {
  concurrentTest as test,
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
  reportedMethods as methods,
} from "./utils";

/**
 * The very first step of `boboddy init` (#140): resolving the real git
 * repository — walking up to the root and reading the `origin` remote — and
 * printing both, before any project-matching or auth logic runs. A
 * subdirectory walk that never tells the user what it found would be silent
 * in exactly the case (running from a subdirectory) it exists to support.
 */

describe("reportResolvedRepository", () => {
  test("reports the resolved repo root and remote, in that order, before returning", async () => {
    const { reporter, calls, tasks } = createRecorder();

    const result = await reportResolvedRepository({
      reporter,
      ports: {
        resolveGitRepository: () =>
          Promise.resolve({
            repoRoot: "/Users/dev/my-repo",
            remoteUrl: "git@github.com:acme/my-repo.git",
          }),
      },
    });

    expect(result).toEqual({
      repoRoot: "/Users/dev/my-repo",
      remoteUrl: "git@github.com:acme/my-repo.git",
    });
    expect(tasks[0]?.message).toBe(REPOSITORY_TASK_LABEL);
    expect(methods(tasks)).toEqual(["startTask", "succeed"]);
    expect(tasks[1]?.message).toContain("/Users/dev/my-repo");
    expect(messages(calls)).toContain(
      "Remote: git@github.com:acme/my-repo.git",
    );
  });

  test("fails the task and rethrows when resolution fails", async () => {
    const { reporter, tasks } = createRecorder();
    const boom = new Error("Not inside a git repository.");

    let caught: Error | null = null;
    try {
      await reportResolvedRepository({
        reporter,
        ports: { resolveGitRepository: () => Promise.reject(boom) },
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBe(boom);
    expect(methods(tasks)).toEqual(["startTask", "fail"]);
  });

  test("never reports a remote when resolution failed", async () => {
    // The remote line is meaningful only once a repo root actually resolved;
    // a failed lookup must not print a stale or fabricated remote.
    const { reporter, calls } = createRecorder();

    try {
      await reportResolvedRepository({
        reporter,
        ports: {
          resolveGitRepository: () => Promise.reject(new Error("boom")),
        },
      });
    } catch {
      // expected
    }

    expect(methods(calls)).not.toContain("info");
  });

  test("strips credentials from the printed remote but returns it unchanged", async () => {
    const { reporter, calls } = createRecorder();
    const remoteUrl = "https://user:ghp_secret@github.com/acme/my-repo.git";

    const result = await reportResolvedRepository({
      reporter,
      ports: {
        resolveGitRepository: () =>
          Promise.resolve({ repoRoot: "/Users/dev/my-repo", remoteUrl }),
      },
    });

    expect(result.remoteUrl).toBe(remoteUrl);
    expect(messages(calls)).toContain(
      "Remote: https://github.com/acme/my-repo.git",
    );
    expect(messages(calls).join("\n")).not.toContain("ghp_secret");
  });
});

describe("warnAboutStrayProjectConfig", () => {
  function withRepo(fn: (repoRoot: string, nested: string) => void): void {
    const repoRoot = mkdtempSync(resolve(tmpdir(), "boboddy-stray-"));
    const nested = join(repoRoot, "packages", "app");
    mkdirSync(nested, { recursive: true });
    try {
      fn(repoRoot, nested);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  function writeConfig(dir: string): void {
    mkdirSync(join(dir, ".boboddy"), { recursive: true });
    writeFileSync(join(dir, ".boboddy", "boboddy.jsonc"), "{}\n");
  }

  test("warns about a leftover subdirectory config, without touching it", () => {
    withRepo((repoRoot, nested) => {
      writeConfig(nested);
      const { reporter, calls } = createRecorder();

      warnAboutStrayProjectConfig({ cwd: nested, repoRoot, reporter });

      expect(calls).toEqual([
        {
          method: "warn",
          message: strayProjectConfigMessage(nested, repoRoot),
        },
      ]);
    });
  });

  test("stays quiet in a subdirectory with no stray config", () => {
    withRepo((repoRoot, nested) => {
      const { reporter, calls } = createRecorder();

      warnAboutStrayProjectConfig({ cwd: nested, repoRoot, reporter });

      expect(calls).toEqual([]);
    });
  });

  test("stays quiet at the repo root, where the config belongs", () => {
    withRepo((repoRoot) => {
      writeConfig(repoRoot);
      const { reporter, calls } = createRecorder();

      warnAboutStrayProjectConfig({ cwd: repoRoot, repoRoot, reporter });

      expect(calls).toEqual([]);
    });
  });
});
