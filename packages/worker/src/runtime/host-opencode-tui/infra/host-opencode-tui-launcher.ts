import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  LAUNCH_WRAPPER_FILENAME,
  resolveHostNativePlatform,
  type OpencodePayloadProgressListener,
  type PayloadPlatform,
} from "../../runtime-service/domain/opencode-runtime-payload";
import {
  OpencodeRuntimePayloadProvisioner,
  type OpencodeRuntimePayloadLocation,
} from "../../runtime-service/infra/opencode-runtime-payload-provisioner";

/**
 * Host-side provisioning + launch of the REAL, interactive OpenCode TUI.
 *
 * This is the CLI-facing counterpart to `HostOpencodeBootstrap`, which starts a
 * DETACHED `opencode serve` on a loopback port for unattended `no_workspace`
 * step executions. Here the requirements are the opposite:
 *
 *   - attached to the user's terminal (`stdio: "inherit"`), not detached
 *   - no port, no health polling, no log file
 *   - the promise resolves only when the user quits the TUI
 *
 * Only the host-native platform binary is provisioned (~100 MB) rather than the
 * worker's full Linux set (~4x that): nothing here is mounted into a container.
 * The shared payload cache tolerates the narrower request because provisioning
 * carries forward platforms it did not fetch.
 */

/** Signals forwarded to the child rather than acted on by the parent. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];

/**
 * Signals the parent swallows entirely. The TUI shares our process group, so
 * the tty already delivers Ctrl+C straight to it; if the parent also acted on
 * SIGINT it would exit and abandon a live TUI holding the terminal.
 */
const SWALLOWED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT"];

export type EnsureHostOpencodePayloadOptions = {
  /** Host home dir override (tests). */
  homeDir?: string | undefined;
  /** npm registry base URL override. */
  registryBaseUrl?: string | undefined;
  /** Override the detected host platform (tests). */
  hostNativePlatform?: PayloadPlatform | null | undefined;
  /** Progress sink so the CLI can render a download indicator. */
  onProgress?: OpencodePayloadProgressListener | undefined;
  /** Injected provisioner (tests). Bypasses all of the options above. */
  provisioner?: OpencodeRuntimePayloadProvisioner | undefined;
};

/**
 * Ensure the pinned OpenCode binary for the CURRENT host platform is present in
 * `~/.boboddy/runtimes/opencode/<version>`, downloading it if needed.
 *
 * Throws when the host OS/arch has no published standalone binary.
 */
export async function ensureHostOpencodePayload(
  options: EnsureHostOpencodePayloadOptions = {},
): Promise<OpencodeRuntimePayloadLocation> {
  if (options.provisioner) {
    return options.provisioner.ensure();
  }

  const hostNativePlatform =
    options.hostNativePlatform === undefined
      ? resolveHostNativePlatform()
      : options.hostNativePlatform;

  if (hostNativePlatform === null) {
    throw new Error(
      `No OpenCode runtime is published for this host ` +
        `(${process.platform}/${process.arch}). Supported hosts are macOS and ` +
        `Linux on arm64 or x64.`,
    );
  }

  const provisioner = new OpencodeRuntimePayloadProvisioner({
    homeDir: options.homeDir,
    registryBaseUrl: options.registryBaseUrl,
    hostNativePlatform,
    // Host-only: the container Linux set is not needed for an interactive run.
    platforms: [hostNativePlatform],
    onProgress: options.onProgress,
  });
  return provisioner.ensure();
}

/**
 * Absolute HOST path of the launchable entrypoint for a provisioned payload.
 *
 * This is the `launch.sh` wrapper, not a raw binary — matching how
 * `HostOpencodeBootstrap` launches. The wrapper detects OS/arch/libc and execs
 * the right standalone binary, so callers never have to.
 */
export function resolveHostOpencodeBinary(
  payload: Pick<OpencodeRuntimePayloadLocation, "hostPayloadDir">,
): string {
  return path.join(payload.hostPayloadDir, LAUNCH_WRAPPER_FILENAME);
}

/** Narrow structural type for the injectable spawn seam. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  },
) => ChildProcess;

export type LaunchOpencodeTuiInput = {
  /** Absolute path from {@link resolveHostOpencodeBinary}. */
  launcherPath: string;
  /** Directory the TUI opens as its project root. */
  cwd: string;
  /** Agent name to boot into. Also set as `default_agent` in the config. */
  agent: string;
  /** Serialized config for `OPENCODE_CONFIG_CONTENT`. */
  configContent: string;
  /** Optional opening user message seeded into the session. */
  seedPrompt?: string | undefined;
  /** Extra env applied on top of `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Injected spawn (tests). Defaults to `node:child_process.spawn`. */
  spawnFn?: SpawnFn | undefined;
};

export type LaunchOpencodeTuiResult = {
  /** Child exit code, or `null` when it was terminated by a signal. */
  exitCode: number | null;
  /** Terminating signal, or `null` on a normal exit. */
  signal: NodeJS.Signals | null;
};

/**
 * Build the argv for the interactive TUI.
 *
 * `--agent` is REQUIRED alongside `default_agent` in the config: `default_agent`
 * silently falls back to `build` when the name does not resolve, whereas the
 * flag fails loudly. Belt and braces.
 */
export function buildOpencodeTuiArgs(input: {
  agent: string;
  seedPrompt?: string | undefined;
}): string[] {
  const args = ["--agent", input.agent];
  if (input.seedPrompt !== undefined && input.seedPrompt.length > 0) {
    args.push("--prompt", input.seedPrompt);
  }
  return args;
}

/**
 * Build the child env. `TMUX`/`TMUX_PANE` are deliberately left intact — the
 * TUI runs fine inside tmux and stripping them breaks the user's session.
 */
export function buildOpencodeTuiEnv(input: {
  configContent: string;
  env?: NodeJS.ProcessEnv | undefined;
  baseEnv?: NodeJS.ProcessEnv | undefined;
}): NodeJS.ProcessEnv {
  return {
    ...(input.baseEnv ?? process.env),
    ...input.env,
    OPENCODE_CONFIG_CONTENT: input.configContent,
  };
}

/**
 * Spawn the OpenCode TUI attached to the current terminal and resolve once the
 * user exits it.
 */
export async function launchOpencodeTui(
  input: LaunchOpencodeTuiInput,
): Promise<LaunchOpencodeTuiResult> {
  const spawnFn = input.spawnFn ?? spawn;
  const child = spawnFn(
    input.launcherPath,
    buildOpencodeTuiArgs({ agent: input.agent, seedPrompt: input.seedPrompt }),
    {
      cwd: input.cwd,
      env: buildOpencodeTuiEnv({
        configContent: input.configContent,
        env: input.env,
      }),
      // Attached: the TUI needs the real tty for input, rendering and resize.
      stdio: "inherit",
    },
  );

  const detachSignals = attachSignalBridge(child);
  try {
    return await waitForExit(child);
  } finally {
    detachSignals();
  }
}

/**
 * Keep the parent alive while the child owns the terminal, forwarding the
 * signals the tty does not deliver on its own. Returns a teardown function.
 */
function attachSignalBridge(child: ChildProcess): () => void {
  const swallow = (): void => {
    // Intentionally empty: the tty already delivered this to the child.
  };
  const forward = (signal: NodeJS.Signals) => (): void => {
    child.kill(signal);
  };

  const registered: [NodeJS.Signals, () => void][] = [];
  for (const signal of SWALLOWED_SIGNALS) {
    process.on(signal, swallow);
    registered.push([signal, swallow]);
  }
  for (const signal of FORWARDED_SIGNALS) {
    const handler = forward(signal);
    process.on(signal, handler);
    registered.push([signal, handler]);
  }

  return () => {
    for (const [signal, handler] of registered) {
      process.off(signal, handler);
    }
  };
}

function waitForExit(child: ChildProcess): Promise<LaunchOpencodeTuiResult> {
  return new Promise<LaunchOpencodeTuiResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ exitCode: code, signal });
    });
  });
}

/**
 * Guard for callers: the TUI is unusable without a real terminal. Throws with a
 * clear message when stdin/stdout are redirected (CI, pipes, `| cat`).
 */
export function assertInteractiveTerminal(
  streams: {
    stdin: { isTTY?: boolean };
    stdout: { isTTY?: boolean };
  } = process,
): void {
  if (streams.stdin.isTTY !== true || streams.stdout.isTTY !== true) {
    throw new Error(
      "This command needs an interactive terminal. Run it directly in your " +
        "shell rather than through a pipe, redirect, or CI runner.",
    );
  }
}
