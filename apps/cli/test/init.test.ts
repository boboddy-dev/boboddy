import { describe, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { concurrentTest, hasReporterLine } from "./utils";

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
  const result = spawnSync(process.execPath, ["run", cliEntrypoint, ...args], {
    cwd: options?.cwd ?? projectRoot,
    env: { ...process.env, ...options?.env },
    encoding: "utf8",
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.status ?? 1,
  };
}

describe("boboddy init", () => {
  describe("help output", () => {
    concurrentTest("init appears in top-level help", () => {
      const result = run(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("init");
    });

    concurrentTest("init --help shows base-url option", () => {
      const result = run(["init", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--base-url");
    });

    concurrentTest("init --help shows work-item-id option", () => {
      const result = run(["init", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--work-item-id");
    });
  });

  describe("pre-checks", () => {
    concurrentTest("errors when not authenticated", () => {
      const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-init-"));
      try {
        const result = run(["init", "--base-url", "https://example.com"], {
          env: { HOME: fakeHome },
        });
        expect(result.exitCode).toBe(1);
        // The not-signed-in message now surfaces on stderr via reporter.error.
        expect(
          hasReporterLine(
            result.stderr,
            "Not signed in to https://example.com. Run 'boboddy auth login' first.",
          ),
        ).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    concurrentTest(
      "resolves and prints the repo path and remote before the auth error",
      () => {
        // `projectRoot` (apps/cli) is itself a subdirectory of this repo's
        // real git root — running from here is exactly the case #140 fixes.
        const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-init-"));
        try {
          const result = run(["init", "--base-url", "https://example.com"], {
            env: { HOME: fakeHome },
          });
          expect(result.exitCode).toBe(1);
          expect(hasReporterLine(result.stderr, "Repository: ")).toBe(true);
          expect(hasReporterLine(result.stderr, "Remote: ")).toBe(true);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
        }
      },
    );

    concurrentTest("fails clearly when run outside any git repository", () => {
      const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-init-"));
      const outsideRepo = mkdtempSync(resolve(tmpdir(), "boboddy-not-a-repo-"));
      try {
        const result = run(["init", "--base-url", "https://example.com"], {
          cwd: outsideRepo,
          env: { HOME: fakeHome },
        });
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
    });
  });
});
