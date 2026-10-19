/**
 * Black-box CLI tests for `boboddy work`'s source-branch resolution/guard
 * (#112): the CLI resolves the user's current local branch (or an explicit
 * `--source-branch` override) and verifies it against `origin` BEFORE any
 * network/auth call, so these tests never need a real signed-in session —
 * they assert on the fail-fast branch-guard message itself, or that the
 * command proceeds past it to the (expected, pre-existing) "not signed in"
 * failure. Mirrors `init.test.ts`'s runCli + fake-HOME style.
 */
import { describe, expect, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  concurrentTest,
  hasReporterLine,
  runCli,
  type SpawnResult,
} from "./utils";

// Each test builds real git repos and spawns the CLI from source; under a
// loaded machine (test-all-workspaces) that overruns bun's 5s default.
setDefaultTimeout(15_000);

const FAKE_PROJECT = "acme/web-app";

function runWork(
  args: readonly string[],
  options: { cwd: string; home: string },
): Promise<SpawnResult> {
  return runCli(["work", FAKE_PROJECT, ...args], {
    cwd: options.cwd,
    env: { HOME: options.home },
  });
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A bare "remote" repo + a clone of it, both under a fresh temp root. */
function buildRepoWithOrigin(): { root: string; workspace: string; remote: string } {
  const root = mkdtempSync(resolve(tmpdir(), "boboddy-work-cli-"));
  const remote = resolve(root, "remote.git");
  const workspace = resolve(root, "workspace");

  git(root, ["init", "--bare", "-b", "main", remote]);

  const seed = resolve(root, "seed");
  git(root, ["clone", remote, seed]);
  git(seed, ["config", "user.email", "seed@boboddy.dev"]);
  git(seed, ["config", "user.name", "Seed"]);
  execFileSync("git", ["-C", seed, "commit", "--allow-empty", "--no-gpg-sign", "-m", "init"]);
  git(seed, ["push", "origin", "main"]);

  git(root, ["clone", remote, workspace]);
  git(workspace, ["config", "user.email", "workspace@boboddy.dev"]);
  git(workspace, ["config", "user.name", "Workspace"]);

  return { root, workspace, remote };
}

describe("boboddy work — source branch", () => {
  concurrentTest("--help documents --source-branch", async () => {
    const result = await runCli(["work", "--help"]);
    expect(result.stdout).toContain("--source-branch");
  });

  concurrentTest(
    "fails fast when the current branch has never been pushed to origin",
    async () => {
      const { root, workspace } = buildRepoWithOrigin();
      try {
        git(workspace, ["checkout", "-b", "feature-never-pushed"]);
        const home = mkdtempSync(resolve(tmpdir(), "boboddy-work-home-"));
        try {
          const result = await runWork([], { cwd: workspace, home });
          expect(result.exitCode).toBe(1);
          expect(
            hasReporterLine(
              result.stderr,
              'Current branch "feature-never-pushed" does not exist on origin',
            ),
          ).toBe(true);
          // Never got far enough to hit the (pre-existing) auth check.
          expect(hasReporterLine(result.stderr, "Not signed in")).toBe(false);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "proceeds past the branch guard (to the pre-existing auth failure) when the current branch is in sync with origin",
    async () => {
      const { root, workspace } = buildRepoWithOrigin();
      try {
        const home = mkdtempSync(resolve(tmpdir(), "boboddy-work-home-"));
        try {
          const result = await runWork([], { cwd: workspace, home });
          expect(
            hasReporterLine(result.stderr, "Using source branch: main"),
          ).toBe(true);
          expect(result.exitCode).toBe(1);
          expect(hasReporterLine(result.stderr, "Not signed in")).toBe(true);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "skips the branch guard entirely when cwd is not a git repository",
    async () => {
      const notARepo = mkdtempSync(resolve(tmpdir(), "boboddy-work-norepo-"));
      const home = mkdtempSync(resolve(tmpdir(), "boboddy-work-home-"));
      try {
        const result = await runWork([], { cwd: notARepo, home });
        expect(hasReporterLine(result.stderr, "does not exist on origin")).toBe(
          false,
        );
        expect(hasReporterLine(result.stderr, "Not signed in")).toBe(true);
      } finally {
        rmSync(notARepo, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "--source-branch overrides the current branch and only requires existence on origin",
    async () => {
      const { root, workspace } = buildRepoWithOrigin();
      try {
        const home = mkdtempSync(resolve(tmpdir(), "boboddy-work-home-"));
        try {
          const result = await runWork(["--source-branch", "ghost-branch"], {
            cwd: workspace,
            home,
          });
          expect(result.exitCode).toBe(1);
          expect(
            hasReporterLine(
              result.stderr,
              'Branch "ghost-branch" (--source-branch) does not exist on origin',
            ),
          ).toBe(true);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
