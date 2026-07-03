import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  logWork,
  logWorkDebug,
  logWorkError,
} from "../../../work/step-execution/application/work-logger";
import type { DevcontainerBindMount } from "./devcontainer-mount-injection";
import {
  patchDevcontainerAppPort,
  patchDevcontainerMounts,
  patchDevcontainerRunArgs,
} from "./devcontainer-mount-injection";
import type { OpencodeRuntimePayloadLocation } from "./opencode-runtime-payload-provisioner";

const execFileAsync = promisify(execFile);

/**
 * Bootstraps the Boboddy-managed OpenCode runtime INSIDE the user devcontainer.
 *
 * Two phases bracket `devcontainers-cli up`:
 *
 *  - {@link planMounts} (pre-up): computes the bind mounts + `appPort` publish
 *    to inject into the cloned devcontainer.json using the SAME mechanism as the
 *    existing `containerEnv` patch (`patchDevcontainerMounts` /
 *    `patchDevcontainerAppPort`). Mounts:
 *      * runtime payload dir  -> /opt/boboddy/runtimes/opencode/<ver> (read-only)
 *      * session agent HOME   -> /opt/boboddy/agent-home              (read-write)
 *      * provider credentials -> /opt/boboddy/provider                (read-only),
 *        only when the resolver's chosen source needs config files.
 *
 *  - {@link prepareAgentHomeConfig} (pre-up, after planMounts): copies the
 *    user's host global opencode config (`~/.config/opencode/opencode.json[c]`)
 *    into the session-scoped agent HOME at `.config/opencode/opencode.json` so
 *    that OpenCode picks it up at precedence level #2 (global config) inside the
 *    container. The project's `.opencode/opencode.json[c]` is left untouched.
 *
 *  - {@link start} (post-up): launches `opencode serve` by ABSOLUTE PATH (the
 *    mounted payload's `launch.sh`), with the dedicated HOME env and the
 *    resolved workspace cwd, binding `0.0.0.0:<containerPort>` so it is
 *    reachable from the host over the published loopback port. Boboddy's
 *    override config is passed as `OPENCODE_CONFIG_CONTENT` (precedence #6 —
 *    inline), ensuring the permission baseline, step MCPs, and
 *    `AGENT_DEFAULT_MODEL` win over the user's home/project configs. Waits for
 *    health and returns the host-facing `agentBaseUrl`.
 *
 * The agent HOME is SESSION-SCOPED on the host (a per-session dir) and removed
 * on {@link stop}, so sessions never share agent state/credentials.
 */

/** In-container path the runtime payload is mounted at is version-specific. */
export const CONTAINER_AGENT_HOME = "/opt/boboddy/agent-home";
/** In-container path the materialized provider config dir is mounted at. */
export const CONTAINER_PROVIDER_DIR = "/opt/boboddy/provider";
/** Port OpenCode binds inside the container; published to a host loopback port. */
export const CONTAINER_OPENCODE_PORT = 4096;

/**
 * `docker run` args injected into the devcontainer so the in-container OpenCode
 * can reach the host over `host.docker.internal`. Docker Desktop (macOS/Windows)
 * provides this alias natively; on Linux it must be added explicitly via the
 * host-gateway alias.
 */
const HOST_GATEWAY_RUN_ARGS = [
  "--add-host",
  "host.docker.internal:host-gateway",
];

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 500;
const HEALTH_PATH = "/global/health";
/** Where the in-container opencode process writes its boot log. */
const AGENT_LOG_DIR = `${CONTAINER_AGENT_HOME}/.boboddy-log`;
/** Filename of the in-container opencode serve log within the log directory. */
export const AGENT_SERVE_LOG_FILENAME = "opencode-serve.log";
const AGENT_LOG_PATH = `${AGENT_LOG_DIR}/${AGENT_SERVE_LOG_FILENAME}`;
const AGENT_PID_PATH = `${AGENT_LOG_DIR}/opencode-serve.pid`;

/**
 * Candidate filenames for the host global opencode config, in resolution order.
 * Mirrors the check in `global-setup.ts` and `opencode-credential-discovery.ts`.
 */
const HOST_GLOBAL_CONFIG_CANDIDATES = [
  "opencode.jsonc",
  "opencode.json",
  "config.json",
] as const;

/**
 * Relative path segments for the OpenCode auth store under the host home.
 * OpenCode reads provider credentials from `~/.local/share/opencode/auth.json`.
 * Mirrors `OPENCODE_AUTH_RELATIVE_PATH` in `opencode-credential-discovery.ts`.
 */
const HOST_AUTH_RELATIVE_PATH = [
  ".local",
  "share",
  "opencode",
  "auth.json",
] as const;

export type PlanMountsInput = {
  payload: OpencodeRuntimePayloadLocation;
  /** Host dir to mount as the session-scoped agent HOME. */
  sessionAgentHomeDir: string;
  /**
   * Host dir of materialized provider config files (the materializer's output
   * dir), mounted READ-ONLY. Omit/undefined when the chosen provider source
   * needs no config files (e.g. token-only via env).
   */
  providerConfigDir?: string | undefined;
};

export type PlanMountsResult = {
  mounts: DevcontainerBindMount[];
  /** Host loopback port chosen for the published OpenCode server. */
  hostPort: number;
};

export type StartInput = {
  containerId: string;
  /** Absolute path the agent operates against inside the container. */
  workspaceFolder: string;
  /** Host loopback port chosen by {@link planMounts}. */
  hostPort: number;
  /** Absolute container path of the launch wrapper. */
  launchWrapperPath: string;
  /**
   * Provider env to launch OpenCode with (token under its `tokenEnv`, base URL,
   * etc.) — produced by the RuntimeConfigMaterializer.
   */
  providerEnv: Record<string, string>;
  /**
   * Boboddy's override config as a JSON string. Passed to the in-container
   * OpenCode as `OPENCODE_CONFIG_CONTENT` (precedence level #6 — inline),
   * which takes effect after the user's global (#2) and project (#4) configs.
   *
   * Carries: permission baseline (security boundary), step MCP servers,
   * step plugins, tools/agent overrides, and AGENT_DEFAULT_MODEL.
   */
  opencodeConfigContent: string;
};

export type StartResult = {
  agentBaseUrl: string;
  agentLogDirectory: string;
};

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((err) => {
        if (err ?? port === null) {
          reject(err ?? new Error("Could not determine free port"));
        } else {
          resolve(port);
        }
      });
    });
    server.on("error", reject);
  });
}

/** Single-quote a value for safe interpolation into a `sh -c` command. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Resolve the host home directory, honoring an explicit `HOME` override.
 * On macOS, `os.homedir()` reads the OS user database and ignores `process.env`,
 * so prefer the env var when set.
 */
function resolveHostHome(): string {
  const explicit = process.env["HOME"]?.trim();
  return explicit && explicit.length > 0 ? explicit : os.homedir();
}

export class DevcontainerOpencodeBootstrap {
  /**
   * Compute the bind mounts + host port to publish, and ensure the
   * session-scoped agent HOME exists on the host. Called BEFORE the devcontainer
   * config is patched and the container is launched.
   */
  async planMounts(input: PlanMountsInput): Promise<PlanMountsResult> {
    await mkdir(input.sessionAgentHomeDir, { recursive: true });

    const mounts: DevcontainerBindMount[] = [
      {
        source: input.payload.hostPayloadDir,
        target: input.payload.containerPayloadDir,
        readOnly: true,
      },
      {
        source: input.sessionAgentHomeDir,
        target: CONTAINER_AGENT_HOME,
        readOnly: false,
      },
    ];

    if (input.providerConfigDir) {
      mounts.push({
        source: input.providerConfigDir,
        target: CONTAINER_PROVIDER_DIR,
        readOnly: true,
      });
    }

    const hostPort = await findFreePort();
    return { mounts, hostPort };
  }

  /**
   * Patch the cloned devcontainer.json with the planned mounts + appPort using
   * the same mechanism as the `containerEnv` patch. Throws for compose-based
   * configs and on conflicting user mounts (see devcontainer-mount-injection).
   */
  async patchConfig(input: {
    workspacePath: string;
    devcontainerConfigPath: string;
    mounts: readonly DevcontainerBindMount[];
    hostPort: number;
  }): Promise<void> {
    await patchDevcontainerMounts(
      input.workspacePath,
      input.devcontainerConfigPath,
      input.mounts,
    );
    await patchDevcontainerAppPort(
      input.workspacePath,
      input.devcontainerConfigPath,
      { hostPort: input.hostPort, containerPort: CONTAINER_OPENCODE_PORT },
    );
    await patchDevcontainerRunArgs(
      input.workspacePath,
      input.devcontainerConfigPath,
      HOST_GATEWAY_RUN_ARGS,
    );
  }

  /**
   * Copy the user's host global opencode config and auth credentials into the
   * session-scoped agent HOME so OpenCode picks them up inside the container
   * without touching the user's project repo.
   *
   * **Config** (`~/.config/opencode/opencode.json[c]`):
   *   Written to `<sessionAgentHomeDir>/.config/opencode/opencode.json` —
   *   OpenCode reads this at precedence level #2 (global config). Carries the
   *   user's `model`, provider options, plugins, etc.
   *
   * **Auth** (`~/.local/share/opencode/auth.json`):
   *   Written to `<sessionAgentHomeDir>/.local/share/opencode/auth.json` —
   *   OpenCode reads provider credentials (`/connect`-stored keys for openai,
   *   anthropic, github-copilot, etc.) from `$XDG_DATA_HOME/opencode/auth.json`.
   *   Without this copy, OpenCode cannot authenticate with any provider other
   *   than the one whose token Boboddy injects via `BOBODDY_PROVIDER_TOKEN`.
   *
   * Must be called AFTER {@link planMounts} (so `sessionAgentHomeDir` exists)
   * and BEFORE the container starts (the dir is bind-mounted RW into the
   * container).
   *
   * When neither file exists on the host, this is a no-op.
   */
  async prepareAgentHomeConfig(input: {
    sessionAgentHomeDir: string;
    /** Override host home dir (for tests). Defaults to resolved host home. */
    hostHomeDir?: string | undefined;
  }): Promise<{ hostConfigPath: string | null; hostAuthPath: string | null }> {
    const hostHome = input.hostHomeDir ?? resolveHostHome();

    // --- Config file ---
    const hostConfigDir = path.join(hostHome, ".config", "opencode");
    let hostConfigPath: string | null = null;
    let hostConfigContent: string | null = null;

    for (const candidate of HOST_GLOBAL_CONFIG_CANDIDATES) {
      const candidatePath = path.join(hostConfigDir, candidate);
      try {
        hostConfigContent = await readFile(candidatePath, "utf8");
        hostConfigPath = candidatePath;
        break;
      } catch {
        // Not found — try next candidate.
      }
    }

    // --- Auth file ---
    const hostAuthPath = path.join(hostHome, ...HOST_AUTH_RELATIVE_PATH);
    let hostAuthContent: string | null = null;
    try {
      hostAuthContent = await readFile(hostAuthPath, "utf8");
    } catch {
      // Not found — no auth file to copy.
    }

    // Write config into the session agent HOME under .config/opencode/
    if (hostConfigContent !== null && hostConfigPath !== null) {
      const destConfigDir = path.join(
        input.sessionAgentHomeDir,
        ".config",
        "opencode",
      );
      await mkdir(destConfigDir, { recursive: true });
      const destConfigPath = path.join(destConfigDir, "opencode.json");
      await writeFile(destConfigPath, hostConfigContent, { encoding: "utf8", mode: 0o600 });
    }

    // Write auth into the session agent HOME under .local/share/opencode/
    if (hostAuthContent !== null) {
      const destAuthDir = path.join(
        input.sessionAgentHomeDir,
        ".local",
        "share",
        "opencode",
      );
      await mkdir(destAuthDir, { recursive: true });
      const destAuthPath = path.join(destAuthDir, "auth.json");
      await writeFile(destAuthPath, hostAuthContent, { encoding: "utf8", mode: 0o600 });
    }

    return {
      hostConfigPath,
      hostAuthPath: hostAuthContent !== null ? hostAuthPath : null,
    };
  }

  /**
   * Launch `opencode serve` inside the running devcontainer by absolute path and
   * wait for health. Returns the host-facing base URL.
   */
  async start(input: StartInput): Promise<StartResult> {
    const agentBaseUrl = `http://127.0.0.1:${String(input.hostPort)}`;

    const envFlags: string[] = [
      "-e",
      `HOME=${CONTAINER_AGENT_HOME}`,
      "-e",
      `XDG_CONFIG_HOME=${CONTAINER_AGENT_HOME}/.config`,
      "-e",
      `XDG_DATA_HOME=${CONTAINER_AGENT_HOME}/.local/share`,
      // Boboddy's override layer: permission baseline, step MCPs, plugins, and
      // AGENT_DEFAULT_MODEL. Wins over global (#2) and project (#4) configs.
      "-e",
      `OPENCODE_CONFIG_CONTENT=${input.opencodeConfigContent}`,
      // The resolved workspace folder OpenCode operates against. The Boboddy
      // OpenCode plugin's step tools (e.g. boboddy-submit-step-findings) read
      // `.boboddy/current-execution/execution.json` relative to the worktree,
      // but OpenCode reports `context.worktree` as "/" inside the container.
      // Without this env the plugin falls back to a "/workspace" default that
      // does not exist here, so the findings tool cannot locate the execution
      // metadata and the step never submits findings. Wire the true workspace
      // folder so resolveWorktree() resolves correctly.
      "-e",
      `BOBODDY_WORKSPACE_FOLDER=${input.workspaceFolder}`,
    ];
    for (const [key, value] of Object.entries(input.providerEnv)) {
      envFlags.push("-e", `${key}=${value}`);
    }

    const serveCommand =
      `mkdir -p ${shQuote(AGENT_LOG_DIR)}; ` +
      `cd ${shQuote(input.workspaceFolder)}; ` +
      `nohup ${shQuote(input.launchWrapperPath)} serve ` +
      `--hostname 0.0.0.0 --port ${String(CONTAINER_OPENCODE_PORT)} ` +
      `>${shQuote(AGENT_LOG_PATH)} 2>&1 < /dev/null & ` +
      `echo $! >${shQuote(AGENT_PID_PATH)}`;

    logWork("runtime", "Starting in-devcontainer OpenCode", {
      containerId: input.containerId,
      agentBaseUrl,
      launchWrapperPath: input.launchWrapperPath,
      workspaceFolder: input.workspaceFolder,
      providerEnvKeys: Object.keys(input.providerEnv).sort(),
    });

    await execFileAsync("docker", [
      "exec",
      ...envFlags,
      input.containerId,
      "sh",
      "-lc",
      serveCommand,
    ]);

    await this.waitForHealth(input.containerId, agentBaseUrl);

    return { agentBaseUrl, agentLogDirectory: AGENT_LOG_DIR };
  }

  /**
   * Stop the in-container OpenCode process. The session-scoped agent HOME is
   * removed by the orchestrator's cleanup (it owns the host dir lifecycle).
   */
  async stop(containerId: string): Promise<void> {
    try {
      await execFileAsync("docker", [
        "exec",
        containerId,
        "sh",
        "-lc",
        `if [ -f ${shQuote(AGENT_PID_PATH)} ]; then ` +
          `pid=$(cat ${shQuote(AGENT_PID_PATH)}); ` +
          `kill "$pid" 2>/dev/null || true; ` +
          `rm -f ${shQuote(AGENT_PID_PATH)}; fi`,
      ]);
    } catch {
      // Ignore — container may already be stopped/removed.
    }
  }

  /** Remove the session-scoped agent HOME from the host. */
  async cleanupSessionHome(sessionAgentHomeDir: string): Promise<void> {
    await rm(sessionAgentHomeDir, { recursive: true, force: true });
  }

  private async waitForHealth(
    containerId: string,
    baseUrl: string,
  ): Promise<void> {
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
          logWork("runtime", "In-devcontainer OpenCode healthy", {
            containerId,
            baseUrl,
            attempts,
          });
          return;
        }
        lastError = `HTTP ${String(response.status)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      logWorkDebug("runtime", "Polling in-devcontainer OpenCode health", {
        containerId,
        baseUrl,
        attempt: attempts,
        lastError,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, HEALTH_INTERVAL_MS);
      });
    }

    const log = await this.readAgentLog(containerId);
    logWorkError("runtime", "In-devcontainer OpenCode failed to become healthy", {
      containerId,
      baseUrl,
      attempts,
      lastError,
      log,
    });
    throw new Error(
      `Timed out waiting for in-devcontainer OpenCode health at ${baseUrl}` +
        (log ? `: ${log}` : ""),
    );
  }

  private async readAgentLog(containerId: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "exec",
        containerId,
        "sh",
        "-lc",
        `if [ -f ${shQuote(AGENT_LOG_PATH)} ]; then tail -c 4000 ${shQuote(AGENT_LOG_PATH)}; fi`,
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}

/**
 * Resolve a session-scoped agent HOME directory on the host. Lives under the
 * OS temp dir keyed by the runtime session id so it is isolated per session and
 * easy to GC; the orchestrator removes it on cleanup.
 */
export function resolveSessionAgentHomeDir(sessionId: string): string {
  return path.join(os.tmpdir(), "boboddy-agent-homes", sessionId);
}
