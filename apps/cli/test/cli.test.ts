import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { concurrentTest, hasReporterLine } from "./utils";

const projectRoot = resolve(import.meta.dir, "..");
const cliEntrypoint = resolve(projectRoot, "src/index.ts");
const wrapperEntrypoint = resolve(projectRoot, "bin/boboddy");

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface LogLine {
  readonly level?: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

function run(command: readonly string[], env?: NodeJS.ProcessEnv): SpawnResult {
  const [file, ...args] = command;

  if (file === undefined) {
    throw new Error("A command is required.");
  }

  const result = spawnSync(file, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.status ?? 1,
  };
}

function parseLogLines(stdout: string): LogLine[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogLine);
}

function hasLogLine(
  logs: readonly LogLine[],
  expected: Partial<LogLine>,
): boolean {
  return logs.some((log) =>
    Object.entries(expected).every(([key, value]) => log[key] === value),
  );
}

describe("boboddy CLI", () => {
  concurrentTest("prints the default hello greeting", () => {
    const result = run([process.execPath, "run", cliEntrypoint, "hello"]);

    expect(result.exitCode).toBe(0);
    expect(hasReporterLine(result.stderr, "Hello, world!")).toBe(true);
    expect(result.stdout).not.toContain("Hello, world!");
  });

  concurrentTest("prints a named hello greeting", () => {
    const result = run([
      process.execPath,
      "run",
      cliEntrypoint,
      "hello",
      "Connor",
    ]);

    expect(result.exitCode).toBe(0);
    expect(hasReporterLine(result.stderr, "Hello, Connor!")).toBe(true);
    expect(result.stdout).not.toContain("Hello, Connor!");
  });

  concurrentTest("prints help output", () => {
    const result = run([process.execPath, "run", cliEntrypoint, "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("hello [name]");
    expect(result.stdout).toContain("runtime <command>");
    expect(result.stdout).toContain("work");
    expect(result.stdout).toContain("report-bug");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain("--version");
  });

  concurrentTest("prints a prefilled bug-report URL with --no-browser", () => {
    const result = run([
      process.execPath,
      "run",
      cliEntrypoint,
      "report-bug",
      "--title",
      "boboddy crashes on init",
      "--description",
      "Steps to reproduce: run init in an empty repo.",
      "--no-browser",
    ]);

    expect(result.exitCode).toBe(0);
    // The machine-readable URL is written directly to stdout as a raw line.
    const urlLine = result.stdout
      .split("\n")
      .find((line) =>
        line.includes("github.com/boboddy-dev/boboddy/issues/new"),
      );
    expect(urlLine).toBeDefined();
    const url = urlLine ?? "";
    expect(url).toContain("title=boboddy+crashes+on+init");
    expect(url).toContain("labels=bug");
    expect(url).toContain("Diagnostics");
    // The human status line is on stderr.
    expect(hasReporterLine(result.stderr, "Submit this URL")).toBe(true);
  });

  concurrentTest("prints version output", () => {
    const result = run([process.execPath, "run", cliEntrypoint, "--version"]);

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "0.0.0\n",
      stderr: "",
    });
  });

  concurrentTest("reports a missing compiled binary in the wrapper", () => {
    const result = run(["node", wrapperEntrypoint, "hello"], {
      BOBODDY_DIST_DIR: resolve(projectRoot, "dist-does-not-exist"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(
      hasLogLine(parseLogLines(result.stdout), { msg: "CLI wrapper failed" }),
    ).toBe(true);
  });

  concurrentTest("reports an unsupported platform in the wrapper", () => {
    const result = run(["node", wrapperEntrypoint, "hello"], {
      BOBODDY_PLATFORM: "freebsd",
      BOBODDY_ARCH: "arm64",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(
      hasLogLine(parseLogLines(result.stdout), { msg: "CLI wrapper failed" }),
    ).toBe(true);
  });

  concurrentTest("reports auth status when not signed in", () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-cli-"));

    try {
      const result = run(
        [
          process.execPath,
          "run",
          cliEntrypoint,
          "auth",
          "status",
          "--base-url",
          "https://example.com",
        ],
        { HOME: fakeHome },
      );

      expect(result.exitCode).toBe(0);
      expect(
        hasReporterLine(result.stderr, "Not signed in to https://example.com"),
      ).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test.concurrent("prints whoami error when auth is missing", () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-cli-"));

    try {
      const result = run(
        [
          process.execPath,
          "run",
          cliEntrypoint,
          "auth",
          "whoami",
          "--base-url",
          "https://example.com",
        ],
        { HOME: fakeHome },
      );

      expect(result.exitCode).toBe(1);
      // The error message surfaces on stderr via reporter.error. stdout still
      // carries the pino diagnostic NDJSON, so don't assert it is empty.
      expect(
        hasReporterLine(result.stderr, "Not signed in to https://example.com."),
      ).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test.concurrent("removes stored auth data on logout", () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-cli-"));
    // The real auth file path is `~/.boboddy.json`; `~/.boboddy` is a legacy
    // path and, as a file, collides with the `~/.boboddy/logs` log dir.
    const authFile = resolve(fakeHome, ".boboddy.json");

    try {
      writeFileSync(
        authFile,
        `${JSON.stringify({
          profiles: {
            "https://example.com": {
              accessToken: "token-123",
              email: "user@example.com",
            },
          },
        })}\n`,
        "utf8",
      );

      const result = run(
        [
          process.execPath,
          "run",
          cliEntrypoint,
          "auth",
          "logout",
          "--base-url",
          "https://example.com",
        ],
        { HOME: fakeHome },
      );

      expect(result.exitCode).toBe(0);
      expect(
        hasReporterLine(result.stderr, "Signed out of https://example.com"),
      ).toBe(true);

      const statusResult = run(
        [
          process.execPath,
          "run",
          cliEntrypoint,
          "auth",
          "status",
          "--base-url",
          "https://example.com",
        ],
        { HOME: fakeHome },
      );

      expect(
        hasReporterLine(
          statusResult.stderr,
          "Not signed in to https://example.com",
        ),
      ).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
