import { describe, expect, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { concurrentTest, runCli, hasReporterLine } from "./utils";

// Spawns the CLI from source; under a loaded machine (test-all-workspaces)
// that overruns bun's 5s default.
setDefaultTimeout(15_000);

describe("boboddy init", () => {
  describe("help output", () => {
    concurrentTest("init appears in top-level help", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("init");
    });

    concurrentTest("init --help shows base-url option", async () => {
      const result = await runCli(["init", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--base-url");
    });

    concurrentTest("init --help shows work-item-id option", async () => {
      const result = await runCli(["init", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--work-item-id");
    });
  });

  describe("pre-checks", () => {
    concurrentTest("errors when not authenticated", async () => {
      const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-init-"));
      try {
        const result = await runCli(
          ["init", "--base-url", "https://example.com"],
          {
            env: { HOME: fakeHome },
          },
        );
        expect(result.exitCode).toBe(1);
        // The not-signed-in message now surfaces on stderr via reporter.error.
        expect(
          hasReporterLine(
            result.stderr,
            "Not signed in to https://example.com. Run 'boboddy auth login' in an interactive terminal, then re-run this command.",
          ),
        ).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    concurrentTest(
      "resolves and prints the repo path and remote before the auth error",
      async () => {
        // `projectRoot` (apps/cli) is itself a subdirectory of this repo's
        // real git root — running from here is exactly the case #140 fixes.
        const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-init-"));
        try {
          const result = await runCli(
            ["init", "--base-url", "https://example.com"],
            {
              env: { HOME: fakeHome },
            },
          );
          expect(result.exitCode).toBe(1);
          expect(hasReporterLine(result.stderr, "Repository: ")).toBe(true);
          expect(hasReporterLine(result.stderr, "Remote: ")).toBe(true);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
        }
      },
    );

    concurrentTest(
      "fails clearly when run outside any git repository",
      async () => {
        const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-init-"));
        const outsideRepo = mkdtempSync(
          resolve(tmpdir(), "boboddy-not-a-repo-"),
        );
        try {
          const result = await runCli(
            ["init", "--base-url", "https://example.com"],
            {
              cwd: outsideRepo,
              env: { HOME: fakeHome },
            },
          );
          expect(result.exitCode).toBe(1);
          expect(
            hasReporterLine(
              result.stderr,
              "Not inside a git repository. Run 'boboddy init' from inside your project's git repository.",
            ),
          ).toBe(true);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
          rmSync(outsideRepo, { recursive: true, force: true });
        }
      },
    );
  });
});
