import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  cliProjectRoot as projectRoot,
  concurrentTest,
  hasReporterLine,
  runCli,
  runCommand,
} from "./utils";

// Spawns the CLI from source; under a loaded machine (test-all-workspaces)
// that overruns bun's 5s default.
setDefaultTimeout(15_000);

const wrapperEntrypoint = resolve(projectRoot, "bin/boboddy");

function runWrapper(env: NodeJS.ProcessEnv) {
  return runCommand(["node", wrapperEntrypoint, "hello"], { env });
}

interface LogLine {
  readonly level?: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
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
  concurrentTest("prints the default hello greeting", async () => {
    const result = await runCli(["hello"]);

    expect(result.exitCode).toBe(0);
    expect(hasReporterLine(result.stderr, "Hello, world!")).toBe(true);
    expect(result.stdout).not.toContain("Hello, world!");
  });

  concurrentTest("prints a named hello greeting", async () => {
    const result = await runCli(["hello", "Connor"]);

    expect(result.exitCode).toBe(0);
    expect(hasReporterLine(result.stderr, "Hello, Connor!")).toBe(true);
    expect(result.stdout).not.toContain("Hello, Connor!");
  });

  concurrentTest("prints help output", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("hello [name]");
    expect(result.stdout).toContain("runtime <command>");
    expect(result.stdout).toContain("work");
    expect(result.stdout).toContain("report-bug");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain("--version");
  });

  concurrentTest(
    "prints a prefilled bug-report URL with --no-browser",
    async () => {
      const result = await runCli([
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
    },
  );

  concurrentTest("prints version output", async () => {
    const result = await runCli(["--version"]);

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "0.0.0\n",
      stderr: "",
    });
  });

  concurrentTest(
    "reports a missing compiled binary in the wrapper",
    async () => {
      const result = await runWrapper({
        BOBODDY_DIST_DIR: resolve(projectRoot, "dist-does-not-exist"),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(
        hasLogLine(parseLogLines(result.stdout), { msg: "CLI wrapper failed" }),
      ).toBe(true);
    },
  );

  concurrentTest("reports an unsupported platform in the wrapper", async () => {
    const result = await runWrapper({
      BOBODDY_PLATFORM: "freebsd",
      BOBODDY_ARCH: "arm64",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(
      hasLogLine(parseLogLines(result.stdout), { msg: "CLI wrapper failed" }),
    ).toBe(true);
  });

  concurrentTest(
    "reports a missing devcontainer bundle in the wrapper",
    async () => {
      // Regression test for a corrupted/partially-extracted install: the
      // platform binary is present but dist/devcontainer/... never got
      // extracted (see script/publish.ts's module doc). This must fail
      // immediately with an actionable message instead of silently passing a
      // bad BOBODDY_DEVCONTAINER_SCRIPT path through to the compiled binary,
      // where it previously surfaced minutes later as an opaque
      // "devcontainer CLI exited with a non-zero exit code".
      const fakeDist = mkdtempSync(resolve(tmpdir(), "boboddy-dist-"));
      try {
        writeFileSync(resolve(fakeDist, "boboddy-darwin-arm64"), "#!/bin/sh\n");

        const result = await runWrapper({
          BOBODDY_DIST_DIR: fakeDist,
          BOBODDY_PLATFORM: "darwin",
          BOBODDY_ARCH: "arm64",
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe("");
        const logs = parseLogLines(result.stdout);
        expect(hasLogLine(logs, { msg: "CLI wrapper failed" })).toBe(true);
        const failure = logs.find((log) => log["msg"] === "CLI wrapper failed");
        expect(String(failure?.["message"])).toContain(
          "Missing devcontainer CLI bundle",
        );
        expect(String(failure?.["message"])).toContain(
          "npm install -g @boboddy/cli",
        );
      } finally {
        rmSync(fakeDist, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "resolves both the binary and devcontainer bundle from a complete dist/ layout",
    async () => {
      // Happy-path counterpart to the two failure tests above: a complete
      // legacy dist/ layout (as produced by `bun run build`, and as
      // BOBODDY_DIST_DIR forces in dev/CI) must get past both integrity checks
      // and reach spawnSync. We don't need the "binary" to actually be a
      // runnable executable — reaching spawnSync (rather than failing on a
      // wrapper-level integrity check) is the thing under test — so a
      // non-executable stand-in is fine as long as the resulting spawn error
      // is Node's ENOEXEC/EACCES, not one of our own "Missing ..." messages.
      const fakeDist = mkdtempSync(resolve(tmpdir(), "boboddy-dist-"));
      try {
        writeFileSync(
          resolve(fakeDist, "boboddy-darwin-arm64"),
          "#!/bin/sh\nexit 0\n",
          {
            mode: 0o755,
          },
        );
        mkdirSync(resolve(fakeDist, "devcontainer", "dist", "spec-node"), {
          recursive: true,
        });
        writeFileSync(
          resolve(
            fakeDist,
            "devcontainer",
            "dist",
            "spec-node",
            "devcontainers-cli.js",
          ),
          "",
        );

        const result = await runWrapper({
          BOBODDY_DIST_DIR: fakeDist,
          BOBODDY_PLATFORM: "darwin",
          BOBODDY_ARCH: "arm64",
        });

        const logs = parseLogLines(result.stdout);
        expect(hasLogLine(logs, { msg: "CLI wrapper failed" })).toBe(false);
      } finally {
        rmSync(fakeDist, { recursive: true, force: true });
      }
    },
  );

  concurrentTest("reports auth status when not signed in", async () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-cli-"));

    try {
      const result = await runCli(
        ["auth", "status", "--base-url", "https://example.com"],
        { env: { HOME: fakeHome } },
      );

      expect(result.exitCode).toBe(0);
      expect(
        hasReporterLine(result.stderr, "Not signed in to https://example.com"),
      ).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test.concurrent("prints whoami error when auth is missing", async () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-cli-"));

    try {
      const result = await runCli(
        ["auth", "whoami", "--base-url", "https://example.com"],
        { env: { HOME: fakeHome } },
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

  test.concurrent("removes stored auth data on logout", async () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), "boboddy-cli-"));
    // The real auth file path is `~/.boboddy/auth.jsonc` (`~/.boboddy` is now
    // the shared directory for `auth.jsonc`, `config.jsonc`, `logs/`, etc.).
    const boboddyDir = resolve(fakeHome, ".boboddy");
    const authFile = resolve(boboddyDir, "auth.jsonc");
    const configFile = resolve(boboddyDir, "config.jsonc");

    try {
      mkdirSync(boboddyDir, { recursive: true });
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
      writeFileSync(
        configFile,
        `${JSON.stringify({
          telemetryDisabled: true,
          artifacts: { localMaxBytes: 1024, localMaxAgeDays: 3 },
        })}\n`,
        "utf8",
      );

      const result = await runCli(
        ["auth", "logout", "--base-url", "https://example.com"],
        { env: { HOME: fakeHome } },
      );

      expect(result.exitCode).toBe(0);
      expect(
        hasReporterLine(result.stderr, "Signed out of https://example.com"),
      ).toBe(true);

      const statusResult = await runCli(
        ["auth", "status", "--base-url", "https://example.com"],
        { env: { HOME: fakeHome } },
      );

      expect(
        hasReporterLine(
          statusResult.stderr,
          "Not signed in to https://example.com",
        ),
      ).toBe(true);

      // `boboddy auth logout` only touches `auth.jsonc` — `config.jsonc`'s
      // telemetry/artifact settings must survive untouched.
      expect(existsSync(configFile)).toBe(true);
      expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({
        telemetryDisabled: true,
        artifacts: { localMaxBytes: 1024, localMaxAgeDays: 3 },
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
