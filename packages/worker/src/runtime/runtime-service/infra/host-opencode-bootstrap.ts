import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { SecretMasker } from "../../../work/task/application/secret-masker";
import {
  logWork,
  logWorkDebug,
  logWorkError,
} from "../../../work/task/application/work-logger";
import { findFreePort } from "./devcontainer-opencode-bootstrap";
import {
  opencodeCredentialSecrets,
  type OpencodeCredential,
} from "./opencode-credential-source";
import { completeOpencodeBoot } from "./opencode-post-readiness";
import {
  generateServerPassword,
  SERVE_LOG_ARGS,
  SERVER_PASSWORD_ENV,
  waitForReadiness,
} from "./opencode-server-contract";
import { formatServeLogExcerpt } from "./opencode-serve-log-excerpt";

/**
 * Bootstraps the Boboddy-managed OpenCode runtime DIRECTLY ON THE HOST for
 * `no_workspace` tasks — no docker, no devcontainer.
 *
 * This mirrors {@link DevcontainerOpencodeBootstrap.start}/`stop`/`waitForHealth`
 * but launches the host launch wrapper (the same `launch.sh` that runs inside a
 * container; it detects arch/libc and execs the right standalone binary) as a
 * plain background child process:
 *
 *   <hostLaunchWrapperPath> serve --hostname 127.0.0.1 --port <freePort>
 *     --print-logs --log-level info
 *
 * The process's `HOME` and every `XDG_*` dir point at a session-scoped agent
 * HOME (prepared by `opencode-agent-home.ts`), so the user's global config is
 * read exactly as on the container path and the server's database, state and
 * cache stay isolated per session. The server is protected by a per-session
 * password (`OPENCODE_SERVER_PASSWORD`) returned to the caller. Boboddy's
 * override config is passed inline via `OPENCODE_CONFIG_CONTENT` (precedence
 * #6), and the resolved provider env is injected as-is. Once ready, config
 * diagnostics are checked and the user's credentials are injected over the API
 * (`opencode-post-readiness.ts`).
 *
 * stdout+stderr are redirected to a host log file so the monitor's log tail can
 * follow it (the host-file tail path in `OpencodeLogTail`).
 */

const HOST_AGENT_LOG_DIRNAME = ".boboddy-log";
/** Filename of the host opencode serve log within the log directory. */
export const HOST_AGENT_SERVE_LOG_FILENAME = "opencode-serve.log";
const HOST_OPENCODE_BIND_HOST = "127.0.0.1";

type HostProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type HostAgentLogReady = {
  /** Directory the serve log lives in. */
  agentLogDirectory: string;
  /** Absolute host path of the serve log file. */
  agentLogPath: string;
};

export type HostStartInput = {
  /** Absolute HOST path of the launch wrapper (`launch.sh`). */
  hostLaunchWrapperPath: string;
  /** OpenCode version the payload provides; readiness requires an exact match. */
  expectedVersion: string;
  /** Absolute path the agent operates against on the host (the temp workdir). */
  workspaceFolder: string;
  /** Session-scoped agent HOME dir (already prepared with the global config). */
  sessionAgentHomeDir: string;
  /**
   * The user's provider credentials, injected over the API once the server is
   * ready. Every secret in them is masked in error output.
   */
  credentials: readonly OpencodeCredential[];
  /**
   * Provider env to launch OpenCode with (token under its `tokenEnv`, base URL,
   * etc.) — produced by the RuntimeConfigMaterializer.
   */
  providerEnv: Record<string, string>;
  /**
   * The step's resolved environment variables (`resolveStepEnv`), spread over
   * the spawn env after {@link providerEnv}. May carry secrets: log key names
   * only.
   */
  stepEnv?: Readonly<Record<string, string>> | undefined;
  /**
   * Boboddy's override config as a JSON string. Passed as
   * `OPENCODE_CONFIG_CONTENT` (precedence level #6 — inline).
   */
  opencodeConfigContent: string;
  /**
   * Called right after the process is spawned, while it is still starting up.
   * The serve log already exists and is being written at this point, so a
   * caller can start tailing it immediately instead of waiting for `start()` to
   * resolve — which never happens when startup fails. Must not throw.
   */
  onLogReady?: ((log: HostAgentLogReady) => void) | undefined;
};

export type HostStartResult = {
  agentBaseUrl: string;
  /** Basic-auth password the server was started with. */
  serverPassword: string;
  /** Directory the host serve log lives in (parallel to the container shape). */
  agentLogDirectory: string;
  /** Absolute host path of the serve log file, for direct host tailing. */
  agentLogPath: string;
  /** OS pid of the spawned opencode process, for {@link HostOpencodeBootstrap.stop}. */
  pid: number;
};

export type HostOpencodeBootstrapOptions = {
  /** Pause between readiness probes. Defaults to the shared readiness interval (500ms). */
  readinessIntervalMs?: number | undefined;
};

export class HostOpencodeBootstrap {
  private readonly readinessIntervalMs: number | undefined;

  constructor(options: HostOpencodeBootstrapOptions = {}) {
    this.readinessIntervalMs = options.readinessIntervalMs;
  }

  /**
   * Spawn `opencode serve` on the host as a detached background process bound to
   * a free loopback port, then wait for health. Returns the base URL + log path
   * + pid the orchestrator needs for tailing and cleanup.
   */
  async start(input: HostStartInput): Promise<HostStartResult> {
    const port = await findFreePort();
    const agentBaseUrl = `http://${HOST_OPENCODE_BIND_HOST}:${String(port)}`;

    const agentLogDirectory = path.join(
      input.sessionAgentHomeDir,
      HOST_AGENT_LOG_DIRNAME,
    );
    await mkdir(agentLogDirectory, { recursive: true });
    const agentLogPath = path.join(
      agentLogDirectory,
      HOST_AGENT_SERVE_LOG_FILENAME,
    );

    const serverPassword = generateServerPassword();

    // Point every OpenCode XDG dir at the session-scoped agent HOME so it
    // reads the user's global config (#2) and keeps its database, state and
    // cache isolated per session.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: input.sessionAgentHomeDir,
      XDG_CONFIG_HOME: path.join(input.sessionAgentHomeDir, ".config"),
      XDG_DATA_HOME: path.join(input.sessionAgentHomeDir, ".local", "share"),
      XDG_STATE_HOME: path.join(input.sessionAgentHomeDir, ".local", "state"),
      XDG_CACHE_HOME: path.join(input.sessionAgentHomeDir, ".cache"),
      // Boboddy override layer (permission baseline, step MCPs, plugins,
      // AGENT_DEFAULT_MODEL). Wins over global (#2) and project (#4) configs.
      OPENCODE_CONFIG_CONTENT: input.opencodeConfigContent,
      // The resolved workspace folder OpenCode operates against; the Boboddy
      // plugin's findings tool reads `.boboddy/current-execution/execution.json`
      // relative to it.
      BOBODDY_WORKSPACE_FOLDER: input.workspaceFolder,
      ...input.providerEnv,
      ...input.stepEnv,
      [SERVER_PASSWORD_ENV]: serverPassword,
    };

    logWork("runtime", "Starting host OpenCode", {
      agentBaseUrl,
      hostLaunchWrapperPath: input.hostLaunchWrapperPath,
      workspaceFolder: input.workspaceFolder,
      agentLogPath,
      providerEnvKeys: Object.keys(input.providerEnv).sort(),
      stepEnvKeys: Object.keys(input.stepEnv ?? {}).sort(),
    });

    // Redirect stdout + stderr to the host log file so the monitor can tail it.
    const logHandle = await open(agentLogPath, "a");
    try {
      const child = spawn(
        input.hostLaunchWrapperPath,
        [
          "serve",
          "--hostname",
          HOST_OPENCODE_BIND_HOST,
          "--port",
          String(port),
          ...SERVE_LOG_ARGS,
        ],
        {
          cwd: input.workspaceFolder,
          env,
          stdio: ["ignore", logHandle.fd, logHandle.fd],
          detached: true,
        },
      );
      // Record an early exit (or spawn error) and wake the health poll so it
      // fails immediately instead of waiting for its next probe.
      let exited: HostProcessExit | null = null;
      let spawnError: Error | null = null;
      const processGone = new AbortController();
      child.once("exit", (code, signal) => {
        exited = { code, signal };
        processGone.abort(new Error("Host OpenCode process exited"));
      });
      child.once("error", (error) => {
        spawnError = error;
        processGone.abort(error);
      });
      const pid = child.pid;
      if (pid === undefined) {
        throw new Error("Host OpenCode process failed to spawn (no pid)");
      }
      // Let the parent exit independently of the child; we track it by pid.
      child.unref();

      input.onLogReady?.({ agentLogDirectory, agentLogPath });

      const masker = new SecretMasker([
        ...Object.values(input.providerEnv),
        ...Object.values(input.stepEnv ?? {}),
        ...opencodeCredentialSecrets(input.credentials),
        serverPassword,
      ]);

      try {
        await this.waitForHealth({
          baseUrl: agentBaseUrl,
          password: serverPassword,
          expectedVersion: input.expectedVersion,
          pid,
          agentLogPath,
          masker,
          getExit: () => exited,
          getSpawnError: () => spawnError,
          processGone: processGone.signal,
        });
        await completeOpencodeBoot({
          baseUrl: agentBaseUrl,
          password: serverPassword,
          workspaceFolder: input.workspaceFolder,
          readLog: () => readFile(agentLogPath, "utf8").catch(() => null),
          masker,
          credentials: input.credentials,
          logContext: { baseUrl: agentBaseUrl, pid },
        });
      } catch (error) {
        // `start()` is throwing before returning, so the orchestrator has no
        // `cleanup` to kill this process. Reap it here to avoid leaking a
        // half-started `opencode serve` (e.g. a wrong-arch binary that hung, or
        // a health timeout while the process is still alive).
        this.stop(pid);
        throw error;
      }

      return {
        agentBaseUrl,
        serverPassword,
        agentLogDirectory,
        agentLogPath,
        pid,
      };
    } finally {
      // The child inherited its own fd for the log; close our handle.
      await logHandle.close();
    }
  }

  /** Kill the spawned host OpenCode process by pid; never throws if already dead. */
  stop(pid: number | null | undefined): void {
    if (pid === null || pid === undefined) {
      return;
    }
    try {
      process.kill(pid);
    } catch {
      // Already exited / not found — nothing to do.
    }
  }

  private async waitForHealth(input: {
    baseUrl: string;
    password: string;
    expectedVersion: string;
    pid: number;
    agentLogPath: string;
    masker: SecretMasker;
    getExit: () => HostProcessExit | null;
    getSpawnError: () => Error | null;
    processGone: AbortSignal;
  }): Promise<void> {
    const { baseUrl, pid, agentLogPath, masker } = input;
    let attempts = 0;

    // Fails fast when the process is already dead: polling a port nothing is
    // listening on can only ever end in the generic "Unable to connect".
    const throwIfProcessDied = async (): Promise<void> => {
      const spawnError = input.getSpawnError();
      const exit = input.getExit();
      if (spawnError === null && exit === null) {
        return;
      }
      const reason =
        spawnError !== null
          ? `failed to spawn: ${spawnError.message}`
          : describeExit(exit);
      logWorkError("runtime", "Host OpenCode exited before becoming healthy", {
        baseUrl,
        pid,
        attempts,
        reason,
      });
      throw new Error(
        `Host OpenCode ${reason} before becoming healthy at ${baseUrl}` +
          (await readLogExcerpt(agentLogPath, masker)),
      );
    };

    const result = await waitForReadiness({
      baseUrl,
      password: input.password,
      expectedVersion: input.expectedVersion,
      intervalMs: this.readinessIntervalMs,
      signal: input.processGone,
      assertAlive: throwIfProcessDied,
      onNotReady: (attempt, reason) => {
        attempts = attempt;
        logWorkDebug("runtime", "Polling host OpenCode readiness", {
          baseUrl,
          pid,
          attempt,
          lastError: reason,
        });
      },
    });

    if (result.kind === "ready") {
      logWork("runtime", "Host OpenCode healthy", {
        baseUrl,
        pid,
        attempts: result.attempts,
      });
      return;
    }

    if (result.kind === "wrong-version") {
      logWorkError("runtime", "Host OpenCode reported an unexpected version", {
        baseUrl,
        pid,
        expectedVersion: input.expectedVersion,
        version: result.version,
      });
      throw new Error(
        `Host OpenCode at ${baseUrl} reports version ${result.version}, ` +
          `expected ${input.expectedVersion}` +
          (await readLogExcerpt(agentLogPath, masker)),
      );
    }

    logWorkError("runtime", "Host OpenCode failed to become healthy", {
      baseUrl,
      pid,
      attempts: result.attempts,
      lastError: result.lastReason,
    });
    throw new Error(
      `Timed out waiting for host OpenCode health at ${baseUrl}` +
        (result.lastReason ? `: ${result.lastReason}` : "") +
        (await readLogExcerpt(agentLogPath, masker)),
    );
  }
}

function describeExit(exit: HostProcessExit | null): string {
  if (exit === null) {
    return "exited";
  }
  if (exit.code !== null) {
    return `exited with code ${String(exit.code)}`;
  }
  return `was killed by signal ${exit.signal ?? "unknown"}`;
}

async function readLogExcerpt(
  agentLogPath: string,
  masker: SecretMasker,
): Promise<string> {
  const raw = await readFile(agentLogPath, "utf8").catch(() => null);
  return formatServeLogExcerpt(raw, masker);
}
