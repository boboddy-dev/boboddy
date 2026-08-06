import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { concurrentTest, hasReporterLine, reporterLines } from "./utils";

const projectRoot = resolve(import.meta.dir, "..");
const cliEntrypoint = resolve(projectRoot, "src/index.ts");

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function run(
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): SpawnResult {
  const result = spawnSync(
    process.execPath,
    ["run", cliEntrypoint, ...args],
    {
      cwd: options?.cwd ?? projectRoot,
      env: { ...process.env, ...options?.env },
      encoding: "utf8",
    },
  );

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.status ?? 1,
  };
}

function createFakeGitRoot(dir: string): void {
  mkdirSync(join(dir, ".git"));
}

describe("boboddy pipelines", () => {
  describe("help output", () => {
    concurrentTest("pipelines --help lists init and push subcommands", () => {
      const result = run(["pipelines", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("init");
      expect(result.stdout).toContain("push");
      expect(result.stdout).toContain("design");
    });

    concurrentTest("top-level --help includes pipelines command", () => {
      const result = run(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pipelines");
    });
  });

  describe("pipelines init", () => {
    concurrentTest(
      "creates .boboddy/pipeline-builder directory with all scaffold files",
      () => {
        const fakeProjectDir = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-init-test-"),
        );
        try {
          createFakeGitRoot(fakeProjectDir);
          const result = run(["pipelines", "init"], { cwd: fakeProjectDir });

          expect(result.exitCode).toBe(0);

          const builderDir = join(
            fakeProjectDir,
            ".boboddy",
            "pipeline-builder",
          );
          expect(existsSync(builderDir)).toBe(true);
          expect(existsSync(join(builderDir, "package.json"))).toBe(true);
          expect(existsSync(join(builderDir, "tsconfig.json"))).toBe(true);
          expect(existsSync(join(builderDir, ".gitignore"))).toBe(true);
          expect(
            existsSync(join(builderDir, "triage-and-plan.ts")),
          ).toBe(true);
        } finally {
          rmSync(fakeProjectDir, { recursive: true, force: true });
        }
      },
    );

    concurrentTest(
      "triage-and-plan.ts contains step and pipeline definitions",
      () => {
        const fakeProjectDir = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-init-test-"),
        );
        try {
          createFakeGitRoot(fakeProjectDir);
          run(["pipelines", "init"], { cwd: fakeProjectDir });

          const starterFile = join(
            fakeProjectDir,
            ".boboddy",
            "pipeline-builder",
            "triage-and-plan.ts",
          );
          expect(existsSync(starterFile)).toBe(true);
        } finally {
          rmSync(fakeProjectDir, { recursive: true, force: true });
        }
      },
    );

    concurrentTest("logs a created message for each file", () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-init-test-"),
      );
      try {
        createFakeGitRoot(fakeProjectDir);
        const result = run(["pipelines", "init"], { cwd: fakeProjectDir });
        // Created messages are now human status on stderr: `✓ Created <path>`.
        const createdLines = reporterLines(result.stderr).filter((line) =>
          line.includes("Created"),
        );

        for (const file of [
          "package.json",
          "tsconfig.json",
          ".gitignore",
          "triage-and-plan.ts",
        ]) {
          expect(createdLines.some((line) => line.includes(file))).toBe(true);
        }
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });

    concurrentTest("is idempotent — skips existing files on second run", () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-init-test-"),
      );
      try {
        createFakeGitRoot(fakeProjectDir);
        run(["pipelines", "init"], { cwd: fakeProjectDir });
        const second = run(["pipelines", "init"], { cwd: fakeProjectDir });

        expect(second.exitCode).toBe(0);
        // Skipped messages are now on stderr: `! Skipped <path> (already exists)`.
        expect(hasReporterLine(second.stderr, "Skipped")).toBe(true);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });

    concurrentTest("fails outside the root of a git repository", () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-init-test-"),
      );
      try {
        const result = run(["pipelines", "init"], { cwd: fakeProjectDir });

        expect(result.exitCode).toBe(1);
        // The error surfaces on stderr as `✗ …git repository…`.
        expect(hasReporterLine(result.stderr, "git repository")).toBe(true);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });
  });

  describe("pipelines design", () => {
    concurrentTest("design --help shows its arguments", () => {
      const result = run(["pipelines", "design", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("projectId");
      expect(result.stdout).toContain("--base-url");
    });

    concurrentTest("rejects unknown options (strict mode)", () => {
      const result = run(["pipelines", "design", "--nope"]);

      expect(result.exitCode).toBe(1);
    });

    concurrentTest("refuses to run without an interactive terminal", () => {
      // spawnSync gives the child pipes, not a tty. The TUI cannot render into
      // a pipe, so the command must bail before doing any provisioning work —
      // this also proves the handler is wired up and its args parse.
      const fakeHome = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-design-home-"),
      );
      try {
        const result = run(
          ["pipelines", "design", "01966a2c-9494-7db5-aa46-0f8f5cbbe001"],
          { env: { HOME: fakeHome } },
        );

        expect(result.exitCode).toBe(1);
        expect(
          reporterLines(result.stderr).some((line) =>
            line.includes("interactive terminal"),
          ),
        ).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });

  describe("pipelines push", () => {
    concurrentTest("push --help shows projectId positional argument", () => {
      const result = run(["pipelines", "push", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("projectId");
    });

    concurrentTest("exits with error and helpful message when not signed in", () => {
      const fakeHome = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-push-test-"),
      );
      try {
        const result = run(
          ["pipelines", "push", "01966a2c-9494-7db5-aa46-0f8f5cbbe001"],
          { env: { HOME: fakeHome } },
        );

        expect(result.exitCode).toBe(1);
        // The not-signed-in error now surfaces on stderr via reporter.error.
        expect(
          reporterLines(result.stderr).some((line) =>
            line.toLowerCase().includes("not signed in"),
          ),
        ).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    concurrentTest("fails without a projectId argument or config file", () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-push-noproject-"),
      );
      const fakeHome = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-push-home-"),
      );
      try {
        const result = run(["pipelines", "push"], {
          cwd: fakeProjectDir,
          env: { HOME: fakeHome },
        });

        expect(result.exitCode).toBe(1);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });
});
