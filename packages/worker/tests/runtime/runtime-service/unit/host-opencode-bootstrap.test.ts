/**
 * Unit test for {@link HostOpencodeBootstrap.start}'s startup-failure handling.
 *
 * Uses real child processes: each test writes a tiny `sh` script standing in for
 * the `launch.sh` wrapper, so the spawn, exit-detection, and serve-log wiring
 * are exercised for real without needing an OpenCode binary.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HostOpencodeBootstrap,
  type HostAgentLogReady,
  type HostStartInput,
} from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";

const FAST_READINESS_INTERVAL_MS = 10;

describe("HostOpencodeBootstrap.start startup failures", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "host-bootstrap-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeLauncher(body: string): Promise<string> {
    const launcher = path.join(tempDir, "launch.sh");
    await writeFile(launcher, `#!/bin/sh\n${body}\n`);
    await chmod(launcher, 0o755);
    return launcher;
  }

  function startInput(
    hostLaunchWrapperPath: string,
    overrides: Partial<HostStartInput> = {},
  ): HostStartInput {
    return {
      hostLaunchWrapperPath,
      workspaceFolder: tempDir,
      sessionAgentHomeDir: path.join(tempDir, "agent-home"),
      providerEnv: {},
      credentials: [],
      opencodeConfigContent: "{}",
      expectedVersion: "2.0.28",
      ...overrides,
    };
  }

  test("fails fast with the exit code and serve log when the process exits during startup", async () => {
    const launcher = await writeLauncher(
      [
        `printf '\\033[91mError: Configuration is invalid\\033[0m\\n'`,
        `echo '↳ Unrecognized key: providers'`,
        `exit 1`,
      ].join("\n"),
    );

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await new HostOpencodeBootstrap({
        readinessIntervalMs: FAST_READINESS_INTERVAL_MS,
      }).start(startInput(launcher));
    } catch (error) {
      caught = error;
    }
    const elapsedMs = Date.now() - startedAt;

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("exited with code 1 before becoming healthy");
    expect(message).toContain("Error: Configuration is invalid");
    expect(message).toContain("Unrecognized key: providers");
    // ANSI color codes are stripped from the excerpt.
    expect(message).not.toContain("\u001b");
    // Nowhere near the 60s health timeout.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  test("fails as soon as the process exits, without waiting for the next readiness probe", async () => {
    const launcher = await writeLauncher(`sleep 0.3\necho dying\nexit 5`);

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await new HostOpencodeBootstrap({ readinessIntervalMs: 30_000 }).start(
        startInput(launcher),
      );
    } catch (error) {
      caught = error;
    }
    const elapsedMs = Date.now() - startedAt;

    expect((caught as Error).message).toContain(
      "exited with code 5 before becoming healthy",
    );
    expect((caught as Error).message).toContain("dying");
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("masks known secret values in the serve log excerpt", async () => {
    const launcher = await writeLauncher(
      [`echo "auth failed for token super-secret-token-value"`, `exit 2`].join(
        "\n",
      ),
    );

    let caught: unknown;
    try {
      await new HostOpencodeBootstrap({
        readinessIntervalMs: FAST_READINESS_INTERVAL_MS,
      }).start(
        startInput(launcher, {
          providerEnv: { BOBODDY_PROVIDER_TOKEN: "super-secret-token-value" },
        }),
      );
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).toContain("exited with code 2");
    expect(message).toContain("auth failed for token ***");
    expect(message).not.toContain("super-secret-token-value");
  });

  test("masks the user's credential secrets in the serve log excerpt", async () => {
    const launcher = await writeLauncher(
      [`echo "refresh rt-secret-value access at-secret-value"`, `exit 4`].join(
        "\n",
      ),
    );

    let caught: unknown;
    try {
      await new HostOpencodeBootstrap({
        readinessIntervalMs: FAST_READINESS_INTERVAL_MS,
      }).start(
        startInput(launcher, {
          credentials: [
            {
              integrationID: "openai",
              source: "export",
              value: {
                type: "oauth",
                methodID: "chatgpt",
                refresh: "rt-secret-value",
                access: "at-secret-value",
                expires: 0,
              },
            },
          ],
        }),
      );
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).toContain("refresh *** access ***");
    expect(message).not.toContain("rt-secret-value");
    expect(message).not.toContain("at-secret-value");
  });

  test("passes a generated server password via env and masks it in the serve log excerpt", async () => {
    const launcher = await writeLauncher(
      [`echo "server password: $OPENCODE_SERVER_PASSWORD"`, `exit 3`].join(
        "\n",
      ),
    );

    let caught: unknown;
    try {
      await new HostOpencodeBootstrap({
        readinessIntervalMs: FAST_READINESS_INTERVAL_MS,
      }).start(startInput(launcher));
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).toContain("exited with code 3");
    expect(message).toContain("server password: ***");
    expect(message).not.toMatch(/server password: [A-Za-z0-9_-]{43}/);
  });

  /**
   * A launcher standing in for `opencode serve`: binds the `--port` it is given
   * and answers `/api/info` with `version`, but only for the basic-auth
   * password in `OPENCODE_SERVER_PASSWORD`.
   */
  async function writeServingLauncher(version: string): Promise<string> {
    const script = path.join(tempDir, "fake-serve.ts");
    await writeFile(
      script,
      [
        `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);`,
        `const expected = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");`,
        `Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) =>`,
        `  req.headers.get("authorization") === expected`,
        `    ? Response.json({ version: ${JSON.stringify(version)} })`,
        `    : new Response("unauthorized", { status: 401 }) });`,
      ].join("\n"),
    );
    return writeLauncher(`exec "${process.execPath}" "${script}" "$@"`);
  }

  test("becomes ready once the server answers the expected version with the generated password", async () => {
    const launcher = await writeServingLauncher("2.0.28");
    const bootstrap = new HostOpencodeBootstrap({
      readinessIntervalMs: FAST_READINESS_INTERVAL_MS,
    });

    const started = await bootstrap.start(startInput(launcher));
    try {
      expect(started.serverPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.agentBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      bootstrap.stop(started.pid);
    }
  });

  test("fails fast when the server reports a different version than launched", async () => {
    const launcher = await writeServingLauncher("1.17.3");

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await new HostOpencodeBootstrap({
        readinessIntervalMs: FAST_READINESS_INTERVAL_MS,
      }).start(startInput(launcher));
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain(
      "reports version 1.17.3, expected 2.0.28",
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  test("reports the serve log to onLogReady during startup, before start() settles", async () => {
    const launcher = await writeLauncher(`echo boom\nexit 1`);

    const ready: HostAgentLogReady[] = [];
    let settled = false;
    let readyBeforeSettled = false;
    let caught: unknown;
    try {
      await new HostOpencodeBootstrap({
        readinessIntervalMs: FAST_READINESS_INTERVAL_MS,
      }).start(
        startInput(launcher, {
          onLogReady: (log) => {
            readyBeforeSettled = !settled;
            ready.push(log);
          },
        }),
      );
    } catch (error) {
      caught = error;
    } finally {
      settled = true;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/exited with code 1/);
    // `start()` had not resolved or rejected yet when the log was reported.
    expect(readyBeforeSettled).toBe(true);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.agentLogPath).toBe(
      path.join(
        tempDir,
        "agent-home",
        ".boboddy-log",
        "opencode-serve.log",
      ),
    );
    expect(ready[0]?.agentLogDirectory).toBe(
      path.join(tempDir, "agent-home", ".boboddy-log"),
    );
  });

  test("reports a spawn failure instead of hanging when the launcher is not executable", async () => {
    const missing = path.join(tempDir, "does-not-exist.sh");

    let caught: unknown;
    try {
      await new HostOpencodeBootstrap({
        readinessIntervalMs: FAST_READINESS_INTERVAL_MS,
      }).start(startInput(missing));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
  });
});
