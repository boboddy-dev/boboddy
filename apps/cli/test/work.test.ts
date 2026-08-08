/**
 * Black-box CLI tests for `boboddy work`'s source-branch resolution/guard
 * (#112): the CLI resolves the user's current local branch (or an explicit
 * `--source-branch` override) and verifies it against `origin` BEFORE any
 * network/auth call, so these tests never need a real signed-in session —
 * they assert on the fail-fast branch-guard message itself, or that the
 * command proceeds past it to the (expected, pre-existing) "not signed in"
 * failure. Mirrors `init.test.ts`'s spawnSync + fake-HOME style.
 */
import { describe, expect } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { concurrentTest, hasReporterLine } from "./utils";

const projectRoot = resolve(import.meta.dir, "..");
const cliEntrypoint = resolve(projectRoot, "src/index.ts");
const FAKE_PROJECT_ID = "019fd6f8-0000-7000-8000-000000000000";

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function runWork(
  args: readonly string[],
  options: { cwd: string; home: string },
): SpawnResult {
  const result = spawnSync(
    process.execPath,
    ["run", cliEntrypoint, "work", FAKE_PROJECT_ID, ...args],
    {
      cwd: options.cwd,
      env: { ...process.env, HOME: options.home },
      encoding: "utf8",
    },
  );
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.status ?? 1,
  };
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
  concurrentTest("--help documents --source-branch", () => {
    const result = spawnSync(
      process.execPath,
      ["run", cliEntrypoint, "work", "--help"],
      { cwd: projectRoot, encoding: "utf8" },
    );
    expect(result.stdout).toContain("--source-branch");
  });

  concurrentTest("fails fast when the current branch has never been pushed to origin", () => {
    const { root, workspace } = buildRepoWithOrigin();
    try {
      git(workspace, ["checkout", "-b", "feature-never-pushed"]);
      const home = mkdtempSync(resolve(tmpdir(), "boboddy-work-home-"));
      try {
        const result = runWork([], { cwd: workspace, home });
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
  });

  concurrentTest("proceeds past the branch guard (to the pre-existing auth failure) when the current branch is in sync with origin", () => {
    const { root, workspace } = buildRepoWithOrigin();
    try {
      const home = mkdtempSync(resolve(tmpdir(), "boboddy-work-home-"));
      try {
        const result = runWork([], { cwd: workspace, home });
        expect(hasReporterLine(result.stderr, "Using source branch: main")).toBe(
          true,
        );
        expect(result.exitCode).toBe(1);
        expect(hasReporterLine(result.stderr, "Not signed in")).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  concurrentTest("skips the branch guard entirely when cwd is not a git repository", () => {
    const notARepo = mkdtempSync(resolve(tmpdir(), "boboddy-work-norepo-"));
    const home = mkdtempSync(resolve(tmpdir(), "boboddy-work-home-"));
    try {
      const result = runWork([], { cwd: notARepo, home });
      expect(hasReporterLine(result.stderr, "does not exist on origin")).toBe(
        false,
      );
      expect(hasReporterLine(result.stderr, "Not signed in")).toBe(true);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  concurrentTest("--source-branch overrides the current branch and only requires existence on origin", () => {
    const { root, workspace } = buildRepoWithOrigin();
    try {
      const home = mkdtempSync(resolve(tmpdir(), "boboddy-work-home-"));
      try {
        const result = runWork(
          ["--source-branch", "ghost-branch"],
          { cwd: workspace, home },
        );
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
  });
});
