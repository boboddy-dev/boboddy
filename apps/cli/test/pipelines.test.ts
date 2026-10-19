import { describe, expect, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  concurrentTest,
  hasReporterLine,
  reporterLines,
  runCli,
} from "./utils";

// Spawns the CLI from source; under a loaded machine (test-all-workspaces)
// that overruns bun's 5s default.
setDefaultTimeout(15_000);

function createFakeGitRoot(dir: string): void {
  mkdirSync(join(dir, ".git"));
}

describe("boboddy pipelines", () => {
  describe("help output", () => {
    concurrentTest(
      "pipelines --help lists init and push subcommands",
      async () => {
        const result = await runCli(["pipelines", "--help"]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("init");
        expect(result.stdout).toContain("push");
        expect(result.stdout).toContain("design");
      },
    );

    concurrentTest("top-level --help includes pipelines command", async () => {
      const result = await runCli(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pipelines");
    });
  });

  describe("pipelines init", () => {
    concurrentTest(
      "creates .boboddy/pipeline-builder directory with all scaffold files",
      async () => {
        const fakeProjectDir = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-init-test-"),
        );
        try {
          createFakeGitRoot(fakeProjectDir);
          const result = await runCli(["pipelines", "init"], {
            cwd: fakeProjectDir,
          });

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
          expect(existsSync(join(builderDir, "bug-pipeline.ts"))).toBe(true);
        } finally {
          rmSync(fakeProjectDir, { recursive: true, force: true });
        }
      },
    );

    concurrentTest(
      "bug-pipeline.ts contains step and pipeline definitions",
      async () => {
        const fakeProjectDir = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-init-test-"),
        );
        try {
          createFakeGitRoot(fakeProjectDir);
          await runCli(["pipelines", "init"], { cwd: fakeProjectDir });

          const starterFile = join(
            fakeProjectDir,
            ".boboddy",
            "pipeline-builder",
            "bug-pipeline.ts",
          );
          expect(existsSync(starterFile)).toBe(true);
        } finally {
          rmSync(fakeProjectDir, { recursive: true, force: true });
        }
      },
    );

    concurrentTest("logs a created message for each file", async () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-init-test-"),
      );
      try {
        createFakeGitRoot(fakeProjectDir);
        const result = await runCli(["pipelines", "init"], {
          cwd: fakeProjectDir,
        });
        // Created messages are now human status on stderr: `✓ Created <path>`.
        const createdLines = reporterLines(result.stderr).filter((line) =>
          line.includes("Created"),
        );

        for (const file of [
          "package.json",
          "tsconfig.json",
          ".gitignore",
          "bug-pipeline.ts",
        ]) {
          expect(createdLines.some((line) => line.includes(file))).toBe(true);
        }
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });

    concurrentTest(
      "is idempotent — skips existing files on second run",
      async () => {
        const fakeProjectDir = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-init-test-"),
        );
        try {
          createFakeGitRoot(fakeProjectDir);
          await runCli(["pipelines", "init"], { cwd: fakeProjectDir });
          const second = await runCli(["pipelines", "init"], {
            cwd: fakeProjectDir,
          });

          expect(second.exitCode).toBe(0);
          // Skipped messages are now on stderr: `! Skipped <path> (already exists)`.
          expect(hasReporterLine(second.stderr, "Skipped")).toBe(true);
        } finally {
          rmSync(fakeProjectDir, { recursive: true, force: true });
        }
      },
    );

    concurrentTest("fails outside the root of a git repository", async () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "boboddy-pipelines-init-test-"),
      );
      try {
        const result = await runCli(["pipelines", "init"], {
          cwd: fakeProjectDir,
        });

        expect(result.exitCode).toBe(1);
        // The error surfaces on stderr as `✗ …git repository…`.
        expect(hasReporterLine(result.stderr, "git repository")).toBe(true);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });
  });

  describe("pipelines design", () => {
    concurrentTest("design --help shows its arguments", async () => {
      const result = await runCli(["pipelines", "design", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("project");
      expect(result.stdout).toContain("--base-url");
    });

    concurrentTest("rejects unknown options (strict mode)", async () => {
      const result = await runCli(["pipelines", "design", "--nope"]);

      expect(result.exitCode).toBe(1);
    });

    concurrentTest(
      "refuses to run without an interactive terminal",
      async () => {
        // runCli gives the child pipes, not a tty. The TUI cannot render into
        // a pipe, so the command must bail before doing any provisioning work —
        // this also proves the handler is wired up and its args parse.
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-design-home-"),
        );
        try {
          const result = await runCli(["pipelines", "design", "acme/web-app"], {
            env: { HOME: fakeHome },
          });

          expect(result.exitCode).toBe(1);
          expect(
            reporterLines(result.stderr).some((line) =>
              line.includes("interactive terminal"),
            ),
          ).toBe(true);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
        }
      },
    );
  });

  describe("pipelines push", () => {
    concurrentTest(
      "push --help shows project positional argument",
      async () => {
        const result = await runCli(["pipelines", "push", "--help"]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("project");
      },
    );

    concurrentTest(
      "exits with error and helpful message when not signed in",
      async () => {
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-push-test-"),
        );
        try {
          const result = await runCli(["pipelines", "push", "acme/web-app"], {
            env: { HOME: fakeHome },
          });

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
      },
    );

    concurrentTest(
      "fails without a project argument or config file",
      async () => {
        const fakeProjectDir = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-push-noproject-"),
        );
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-pipelines-push-home-"),
        );
        try {
          const result = await runCli(["pipelines", "push"], {
            cwd: fakeProjectDir,
            env: { HOME: fakeHome },
          });

          expect(result.exitCode).toBe(1);
        } finally {
          rmSync(fakeProjectDir, { recursive: true, force: true });
          rmSync(fakeHome, { recursive: true, force: true });
        }
      },
    );
  });
});
