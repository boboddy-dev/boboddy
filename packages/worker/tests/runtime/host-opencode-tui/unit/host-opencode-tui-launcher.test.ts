import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  OPENCODE_RUNTIME_VERSION,
  type PayloadPlatform,
} from "../../../../src/runtime/runtime-service/domain/opencode-runtime-payload";
import { OpencodeRuntimePayloadProvisioner } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import type { OpencodeRuntimePayloadLocation } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import {
  assertInteractiveTerminal,
  buildOpencodeTuiArgs,
  buildOpencodeTuiEnv,
  ensureHostOpencodePayload,
  hasFailedExitCode,
  launchOpencodeAuthLogin,
  launchOpencodeTui,
  resolveHostOpencodeBinary,
} from "../../../../src/runtime/host-opencode-tui/infra/host-opencode-tui-launcher";
import {
  captureError,
  makeSpawnFake,
  seedHostPayload,
} from "./helpers/host-opencode-tui-fakes";

/**
 * Unit coverage for host-side provisioning + TUI launch.
 *
 * NOTHING here downloads a binary or spawns a real TUI: the payload cache is
 * pre-seeded on disk with a fake binary (so `ensure()` takes its cache-hit
 * path), and `spawn` is injected. See `./helpers/host-opencode-tui-fakes.ts`.
 */

const FAKE_PLATFORM: PayloadPlatform = "darwin-arm64";

describe("ensureHostOpencodePayload", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "host-tui-payload-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("reuses an already-cached host-native payload without downloading", async () => {
    const expectedDir = await seedHostPayload(homeDir, [FAKE_PLATFORM]);

    const payload = await ensureHostOpencodePayload({
      homeDir,
      hostNativePlatform: FAKE_PLATFORM,
      // A bogus registry: any download attempt would fail the test loudly.
      registryBaseUrl: "http://127.0.0.1:1/registry-must-not-be-used",
    });

    expect(payload.version).toBe(OPENCODE_RUNTIME_VERSION);
    expect(payload.hostPayloadDir).toBe(expectedDir);
    expect(payload.containerPayloadDir).toBe(
      `/opt/boboddy/runtimes/opencode/${OPENCODE_RUNTIME_VERSION}`,
    );
  });

  test("emits a cache-hit progress event so the CLI can skip its spinner", async () => {
    await seedHostPayload(homeDir, [FAKE_PLATFORM]);
    const phases: string[] = [];

    await ensureHostOpencodePayload({
      homeDir,
      hostNativePlatform: FAKE_PLATFORM,
      onProgress: (event) => phases.push(event.phase),
    });

    expect(phases).toEqual(["cache-hit"]);
  });

  test("only requires the host-native binary, not the container Linux set", async () => {
    // Seeded with ONLY darwin-arm64: a provisioner asking for the Linux set
    // would consider this invalid and try to download.
    await seedHostPayload(homeDir, [FAKE_PLATFORM]);
    const phases: string[] = [];

    await ensureHostOpencodePayload({
      homeDir,
      hostNativePlatform: FAKE_PLATFORM,
      onProgress: (event) => phases.push(event.phase),
    });

    expect(phases).not.toContain("provision-start");
  });

  test("throws a clear error on an unsupported host platform", async () => {
    const error = await captureError(() =>
      ensureHostOpencodePayload({ homeDir, hostNativePlatform: null }),
    );
    expect(error?.message).toMatch(
      /No OpenCode runtime is published for this host/u,
    );
  });

  test("delegates to an injected provisioner when supplied", async () => {
    const location: OpencodeRuntimePayloadLocation = {
      version: "0.0.0-test",
      hostPayloadDir: "/host/payload",
      containerPayloadDir: "/opt/boboddy/runtimes/opencode/0.0.0-test",
      containerLaunchWrapperPath:
        "/opt/boboddy/runtimes/opencode/0.0.0-test/launch.sh",
    };
    class StubProvisioner extends OpencodeRuntimePayloadProvisioner {
      override ensure(): Promise<OpencodeRuntimePayloadLocation> {
        return Promise.resolve(location);
      }
    }

    const payload = await ensureHostOpencodePayload({
      provisioner: new StubProvisioner(),
    });

    expect(payload).toEqual(location);
  });
});

describe("resolveHostOpencodeBinary", () => {
  test.concurrent("returns the launch.sh wrapper, not a raw binary", () => {
    expect(
      resolveHostOpencodeBinary({ hostPayloadDir: "/cache/opencode/1.18.11" }),
    ).toBe("/cache/opencode/1.18.11/launch.sh");
  });
});

describe("buildOpencodeTuiArgs", () => {
  test.concurrent("always passes --agent as the default_agent guard", () => {
    expect(buildOpencodeTuiArgs({ agent: "pipeline-designer" })).toEqual([
      "--agent",
      "pipeline-designer",
    ]);
  });

  test.concurrent("adds --prompt only when a seed prompt is supplied", () => {
    expect(
      buildOpencodeTuiArgs({ agent: "a", seedPrompt: "hello there" }),
    ).toEqual(["--agent", "a", "--prompt", "hello there"]);
    expect(buildOpencodeTuiArgs({ agent: "a", seedPrompt: "" })).toEqual([
      "--agent",
      "a",
    ]);
  });

  test.concurrent("never emits a serve subcommand or a port", () => {
    const args = buildOpencodeTuiArgs({ agent: "a", seedPrompt: "s" });
    expect(args).not.toContain("serve");
    expect(args).not.toContain("--port");
  });
});

describe("buildOpencodeTuiEnv", () => {
  test.concurrent("injects OPENCODE_CONFIG_CONTENT over the base env", () => {
    const env = buildOpencodeTuiEnv({
      configContent: '{"default_agent":"x"}',
      baseEnv: { PATH: "/usr/bin", OPENCODE_CONFIG_CONTENT: "stale" },
    });

    expect(env["OPENCODE_CONFIG_CONTENT"]).toBe('{"default_agent":"x"}');
    expect(env["PATH"]).toBe("/usr/bin");
  });

  test.concurrent("preserves TMUX so the TUI keeps working inside tmux", () => {
    const env = buildOpencodeTuiEnv({
      configContent: "{}",
      baseEnv: { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%3" },
    });

    expect(env["TMUX"]).toBe("/tmp/tmux-501/default,1,0");
    expect(env["TMUX_PANE"]).toBe("%3");
  });
});

describe("launchOpencodeTui", () => {
  test("spawns attached to the terminal in the given cwd", async () => {
    const { spawnFn, calls, children } = makeSpawnFake();

    const pending = launchOpencodeTui({
      launcherPath: "/cache/launch.sh",
      cwd: "/project/.boboddy/pipeline-builder",
      agent: "pipeline-designer",
      configContent: '{"default_agent":"pipeline-designer"}',
      seedPrompt: "Let's design a pipeline",
      spawnFn,
    });

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.command).toBe("/cache/launch.sh");
    expect(call?.stdio).toBe("inherit");
    expect(call?.cwd).toBe("/project/.boboddy/pipeline-builder");
    expect(call?.args).toEqual([
      "--agent",
      "pipeline-designer",
      "--prompt",
      "Let's design a pipeline",
    ]);
    expect(call?.env["OPENCODE_CONFIG_CONTENT"]).toBe(
      '{"default_agent":"pipeline-designer"}',
    );

    children[0]?.emit("exit", 0, null);
    expect(await pending).toEqual({ exitCode: 0, signal: null });
  });

  test("resolves with the child's non-zero exit code", async () => {
    const { spawnFn, children } = makeSpawnFake();
    const pending = launchOpencodeTui({
      launcherPath: "/cache/launch.sh",
      cwd: "/tmp",
      agent: "a",
      configContent: "{}",
      spawnFn,
    });

    children[0]?.emit("exit", 3, null);
    expect(await pending).toEqual({ exitCode: 3, signal: null });
  });

  test("reports a signal-terminated child", async () => {
    const { spawnFn, children } = makeSpawnFake();
    const pending = launchOpencodeTui({
      launcherPath: "/cache/launch.sh",
      cwd: "/tmp",
      agent: "a",
      configContent: "{}",
      spawnFn,
    });

    children[0]?.emit("exit", null, "SIGTERM");
    expect(await pending).toEqual({ exitCode: null, signal: "SIGTERM" });
  });

  test("rejects when the child fails to spawn", async () => {
    const { spawnFn, children } = makeSpawnFake();
    const pending = launchOpencodeTui({
      launcherPath: "/nope/launch.sh",
      cwd: "/tmp",
      agent: "a",
      configContent: "{}",
      spawnFn,
    });

    children[0]?.emit("error", new Error("ENOENT"));
    const error = await captureError(() => pending);
    expect(error?.message).toBe("ENOENT");
  });

  test("does not leak signal listeners after the child exits", async () => {
    const before = process.listenerCount("SIGINT");
    const { spawnFn, children } = makeSpawnFake();
    const pending = launchOpencodeTui({
      launcherPath: "/cache/launch.sh",
      cwd: "/tmp",
      agent: "a",
      configContent: "{}",
      spawnFn,
    });

    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    children[0]?.emit("exit", 0, null);
    await pending;

    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("forwards SIGTERM to the child instead of dying itself", async () => {
    const { spawnFn, children } = makeSpawnFake();
    const pending = launchOpencodeTui({
      launcherPath: "/cache/launch.sh",
      cwd: "/tmp",
      agent: "a",
      configContent: "{}",
      spawnFn,
    });

    process.emit("SIGTERM");
    expect(children[0]?.killSignals).toEqual(["SIGTERM"]);

    // SIGINT is swallowed: the tty already delivered it to the child directly.
    process.emit("SIGINT");
    expect(children[0]?.killSignals).toEqual(["SIGTERM"]);

    children[0]?.emit("exit", 0, null);
    await pending;
  });
});

describe("launchOpencodeAuthLogin", () => {
  test("spawns `auth login` attached to the terminal", async () => {
    const { spawnFn, calls, children } = makeSpawnFake();

    const pending = launchOpencodeAuthLogin({
      launcherPath: "/cache/launch.sh",
      cwd: "/project",
      spawnFn,
    });

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.command).toBe("/cache/launch.sh");
    expect(call?.args).toEqual(["auth", "login"]);
    expect(call?.stdio).toBe("inherit");
    expect(call?.cwd).toBe("/project");

    children[0]?.emit("exit", 0, null);
    expect(await pending).toEqual({ exitCode: 0, signal: null });
  });

  test("defaults cwd to process.cwd() when not given", async () => {
    const { spawnFn, calls, children } = makeSpawnFake();

    const pending = launchOpencodeAuthLogin({
      launcherPath: "/cache/launch.sh",
      spawnFn,
    });

    expect(calls[0]?.cwd).toBe(process.cwd());
    children[0]?.emit("exit", 0, null);
    await pending;
  });

  test("resolves with a non-zero exit code rather than throwing", async () => {
    const { spawnFn, children } = makeSpawnFake();
    const pending = launchOpencodeAuthLogin({
      launcherPath: "/cache/launch.sh",
      spawnFn,
    });

    children[0]?.emit("exit", 1, null);
    expect(await pending).toEqual({ exitCode: 1, signal: null });
  });

  test("does not leak signal listeners after the child exits", async () => {
    const before = process.listenerCount("SIGINT");
    const { spawnFn, children } = makeSpawnFake();
    const pending = launchOpencodeAuthLogin({
      launcherPath: "/cache/launch.sh",
      spawnFn,
    });

    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    children[0]?.emit("exit", 0, null);
    await pending;

    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("hasFailedExitCode", () => {
  test.concurrent("is false for a clean exit", () => {
    expect(hasFailedExitCode({ exitCode: 0, signal: null })).toBe(false);
  });

  test.concurrent("is false for a signal-terminated child", () => {
    expect(hasFailedExitCode({ exitCode: null, signal: "SIGTERM" })).toBe(
      false,
    );
  });

  test.concurrent("is true for a non-zero exit code", () => {
    expect(hasFailedExitCode({ exitCode: 3, signal: null })).toBe(true);
  });
});

describe("assertInteractiveTerminal", () => {
  test.concurrent("passes when both stdin and stdout are TTYs", () => {
    expect(() => {
      assertInteractiveTerminal({
        stdin: { isTTY: true },
        stdout: { isTTY: true },
      });
    }).not.toThrow();
  });

  test.concurrent("throws when the streams are redirected", () => {
    expect(() => {
      assertInteractiveTerminal({
        stdin: { isTTY: true },
        stdout: { isTTY: false },
      });
    }).toThrow(/interactive terminal/u);
    expect(() => {
      assertInteractiveTerminal({ stdin: {}, stdout: {} });
    }).toThrow(/interactive terminal/u);
  });
});
