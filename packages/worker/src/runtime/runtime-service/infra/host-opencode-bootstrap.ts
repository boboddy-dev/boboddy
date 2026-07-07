import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import {
  logWork,
  logWorkDebug,
  logWorkError,
} from "../../../work/step-execution/application/work-logger";
import { findFreePort } from "./devcontainer-opencode-bootstrap";

/**
 * Bootstraps the Boboddy-managed OpenCode runtime DIRECTLY ON THE HOST for
 * `no_workspace` step executions — no docker, no devcontainer.
 *
 * This mirrors {@link DevcontainerOpencodeBootstrap.start}/`stop`/`waitForHealth`
 * but launches the host launch wrapper (the same `launch.sh` that runs inside a
 * container; it detects arch/libc and execs the right standalone binary) as a
 * plain background child process:
 *
 *   <hostLaunchWrapperPath> serve --hostname 127.0.0.1 --port <freePort>
 *
 * The process's `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME` point at a
 * session-scoped agent HOME (prepared by `opencode-agent-home.ts`), so the
 * user's global config + provider auth are read exactly as on the container
 * path. Boboddy's override config is passed inline via `OPENCODE_CONFIG_CONTENT`
 * (precedence #6), and the resolved provider env is injected as-is.
 *
 * stdout+stderr are redirected to a host log file so the monitor's log tail can
 * follow it (the host-file tail path in `OpencodeLogTail`).
 */

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 500;
const HEALTH_PATH = "/global/health";
const HOST_AGENT_LOG_DIRNAME = ".boboddy-log";
/** Filename of the host opencode serve log within the log directory. */
export const HOST_AGENT_SERVE_LOG_FILENAME = "opencode-serve.log";
const HOST_OPENCODE_BIND_HOST = "127.0.0.1";

export type HostStartInput = {
  /** Absolute HOST path of the launch wrapper (`launch.sh`). */
  hostLaunchWrapperPath: string;
  /** Absolute path the agent operates against on the host (the temp workdir). */
  workspaceFolder: string;
  /** Session-scoped agent HOME dir (already prepared with config/auth). */
  sessionAgentHomeDir: string;
  /**
   * Provider env to launch OpenCode with (token under its `tokenEnv`, base URL,
   * etc.) — produced by the RuntimeConfigMaterializer.
   */
  providerEnv: Record<string, string>;
  /**
   * Boboddy's override config as a JSON string. Passed as
   * `OPENCODE_CONFIG_CONTENT` (precedence level #6 — inline).
   */
  opencodeConfigContent: string;
};

export type HostStartResult = {
  agentBaseUrl: string;
  /** Directory the host serve log lives in (parallel to the container shape). */
  agentLogDirectory: string;
  /** Absolute host path of the serve log file, for direct host tailing. */
  agentLogPath: string;
  /** OS pid of the spawned opencode process, for {@link HostOpencodeBootstrap.stop}. */
  pid: number;
};

export class HostOpencodeBootstrap {
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

    // Point OpenCode's config/data dirs at the session-scoped agent HOME so it
    // reads the user's global config (#2) + provider auth, isolated per session.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: input.sessionAgentHomeDir,
      XDG_CONFIG_HOME: path.join(input.sessionAgentHomeDir, ".config"),
      XDG_DATA_HOME: path.join(input.sessionAgentHomeDir, ".local", "share"),
      // Boboddy override layer (permission baseline, step MCPs, plugins,
      // AGENT_DEFAULT_MODEL). Wins over global (#2) and project (#4) configs.
      OPENCODE_CONFIG_CONTENT: input.opencodeConfigContent,
      // The resolved workspace folder OpenCode operates against; the Boboddy
      // plugin's findings tool reads `.boboddy/current-execution/execution.json`
      // relative to it.
      BOBODDY_WORKSPACE_FOLDER: input.workspaceFolder,
      ...input.providerEnv,
    };

    logWork("runtime", "Starting host OpenCode", {
      agentBaseUrl,
      hostLaunchWrapperPath: input.hostLaunchWrapperPath,
      workspaceFolder: input.workspaceFolder,
      agentLogPath,
      providerEnvKeys: Object.keys(input.providerEnv).sort(),
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
        ],
        {
          cwd: input.workspaceFolder,
          env,
          stdio: ["ignore", logHandle.fd, logHandle.fd],
          detached: true,
        },
      );
      const pid = child.pid;
      if (pid === undefined) {
        throw new Error("Host OpenCode process failed to spawn (no pid)");
      }
      // Let the parent exit independently of the child; we track it by pid.
      child.unref();

      try {
        await this.waitForHealth(agentBaseUrl, pid);
      } catch (error) {
        // `start()` is throwing before returning, so the orchestrator has no
        // `cleanup` to kill this process. Reap it here to avoid leaking a
        // half-started `opencode serve` (e.g. a wrong-arch binary that hung, or
        // a health timeout while the process is still alive).
        this.stop(pid);
        throw error;
      }

      return { agentBaseUrl, agentLogDirectory, agentLogPath, pid };
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

  private async waitForHealth(baseUrl: string, pid: number): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let attempts = 0;
    let lastError: string | null = null;

    while (Date.now() < deadline) {
      attempts += 1;
      try {
        const response = await fetch(`${baseUrl}${HEALTH_PATH}`, {
          signal: AbortSignal.timeout(HEALTH_INTERVAL_MS),
        });
        if (response.ok) {
          logWork("runtime", "Host OpenCode healthy", {
            baseUrl,
            pid,
            attempts,
          });
          return;
        }
        lastError = `HTTP ${String(response.status)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      logWorkDebug("runtime", "Polling host OpenCode health", {
        baseUrl,
        pid,
        attempt: attempts,
        lastError,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, HEALTH_INTERVAL_MS);
      });
    }

    logWorkError("runtime", "Host OpenCode failed to become healthy", {
      baseUrl,
      pid,
      attempts,
      lastError,
    });
    throw new Error(
      `Timed out waiting for host OpenCode health at ${baseUrl}` +
        (lastError ? `: ${lastError}` : ""),
    );
  }
}
