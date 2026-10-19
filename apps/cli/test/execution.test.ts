import { describe, expect, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concurrentTest, runCli, reporterLines } from "./utils";

// Spawns the CLI from source; under a loaded machine (test-all-workspaces)
// that overruns bun's 5s default.
setDefaultTimeout(15_000);

describe("boboddy execution", () => {
  describe("help output", () => {
    concurrentTest("execution --help lists the view subcommand", async () => {
      const result = await runCli(["execution", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("view <executionId>");
    });

    concurrentTest(
      "top-level --help includes the execution command",
      async () => {
        const result = await runCli(["--help"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("execution <command>");
      },
    );

    concurrentTest("execution view --help lists every flag", async () => {
      const result = await runCli(["execution", "view", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("executionId");
      expect(result.stdout).toContain("--attempt");
      expect(result.stdout).toContain("--step");
      expect(result.stdout).toContain("--log");
      expect(result.stdout).toContain("--log-stream");
      expect(result.stdout).toContain("--artifacts");
      expect(result.stdout).toContain("--base-url");
    });

    concurrentTest("rejects unknown options (strict mode)", async () => {
      const result = await runCli([
        "execution",
        "view",
        "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
        "--nope",
      ]);

      expect(result.exitCode).toBe(1);
    });
  });

  describe("execution view", () => {
    concurrentTest(
      "exits with error and helpful message when not signed in",
      async () => {
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-execution-view-test-"),
        );
        try {
          const result = await runCli(
            ["execution", "view", "01966a2c-9494-7db5-aa46-0f8f5cbbe001"],
            { env: { HOME: fakeHome } },
          );

          expect(result.exitCode).toBe(1);
          // The not-signed-in error surfaces on stderr via reporter.error, the
          // same as every other command that calls `connectApi`/
          // `loadAuthenticatedSession` (see pipelines.test.ts).
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
      "rejects an invalid --log-stream value before connecting",
      async () => {
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-execution-view-logstream-test-"),
        );
        try {
          const result = await runCli(
            [
              "execution",
              "view",
              "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
              "--log-stream",
              "not-a-real-stream",
            ],
            { env: { HOME: fakeHome } },
          );

          expect(result.exitCode).toBe(1);
          expect(
            reporterLines(result.stderr).some((line) =>
              line.includes("Invalid --log-stream"),
            ),
          ).toBe(true);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
        }
      },
    );
  });
});
