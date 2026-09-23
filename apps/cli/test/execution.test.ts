import { describe, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { concurrentTest, reporterLines } from "./utils";

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

describe("boboddy execution", () => {
  describe("help output", () => {
    concurrentTest("execution --help lists the view subcommand", () => {
      const result = run(["execution", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("view <executionId>");
    });

    concurrentTest("top-level --help includes the execution command", () => {
      const result = run(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("execution <command>");
    });

    concurrentTest("execution view --help lists every flag", () => {
      const result = run(["execution", "view", "--help"]);

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

    concurrentTest("rejects unknown options (strict mode)", () => {
      const result = run([
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
      () => {
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-execution-view-test-"),
        );
        try {
          const result = run(
            [
              "execution",
              "view",
              "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
            ],
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
      () => {
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-execution-view-logstream-test-"),
        );
        try {
          const result = run(
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
