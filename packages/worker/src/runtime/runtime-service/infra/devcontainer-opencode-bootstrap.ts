import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { SecretMasker } from "../../../work/task/application/secret-masker";
import {
  logWork,
  logWorkDebug,
  logWorkError,
} from "../../../work/task/application/work-logger";
import type { DevcontainerBindMount } from "./devcontainer-mount-injection";
import { buildDockerEnvFlags } from "./docker-env-flags";
import {
  patchDevcontainerAppPort,
  patchDevcontainerMounts,
  patchDevcontainerRunArgs,
} from "./devcontainer-mount-injection";
import type { OpencodeRuntimePayloadLocation } from "./opencode-runtime-payload-provisioner";
import {
  cleanupSessionHome,
  resolveHostAgentHomeSources,
  resolveSessionAgentHomeDir,
} from "./opencode-agent-home";
import { isContainerProcessAlive } from "./container-process-liveness";
import { CONFIG_DIAGNOSTIC_MESSAGE } from "./opencode-config-diagnostics";
import {
  opencodeCredentialSecrets,
  type OpencodeCredential,
} from "./opencode-credential-source";
import { completeOpencodeBoot } from "./opencode-post-readiness";
import { formatServeLogExcerpt } from "./opencode-serve-log-excerpt";
import {
  generateServerPassword,
  SERVE_LOG_ARGS,
  SERVER_PASSWORD_ENV,
  waitForReadiness,
} from "./opencode-server-contract";

// Re-export so existing importers of these helpers from this module keep
// working; the implementations now live in the shared agent-home module.
export { resolveSessionAgentHomeDir };

const execFileAsync = promisify(execFile);

/**
 * Bootstraps the Boboddy-managed OpenCode runtime INSIDE the user devcontainer.
 *
 * The agent HOME ({@link CONTAINER_AGENT_HOME}) lives on the container's NATIVE
 * OVERLAY filesystem — it is NOT a host bind mount. A macOS host bind mount
 * (Docker Desktop `fakeowner`/gRPC-FUSE) has unstable file metadata that breaks
 * tools like npm's `_npx` lock verification, so the agent HOME is created and
 * seeded INSIDE the running container instead of being pre-populated on the host.
 *
 * Three phases bracket `devcontainers-cli up`:
 *
 *  - {@link planMounts} (pre-up): computes the bind mounts + `appPort` publish
 *    to inject into the cloned devcontainer.json using the SAME mechanism as the
 *    existing `containerEnv` patch (`patchDevcontainerMounts` /
 *    `patchDevcontainerAppPort`). Mounts:
 *      * runtime payload dir  -> /opt/boboddy/runtimes/opencode/<ver> (read-only)
 *      * provider credentials -> /opt/boboddy/provider                (read-only),
 *        only when the resolver's chosen source needs config files.
 *    The agent HOME is deliberately NOT mounted — it lives on overlay.
 *
 *  - {@link prepareAgentHome} (post-up, before {@link start}): once the
 *    container is running, creates the agent HOME's `.config/opencode` dir on
 *    overlay via `docker exec ... mkdir -p`, then seeds the user's host global
 *    opencode config (`~/.config/opencode/opencode.json[c]`, precedence #2) by
 *    piping its contents over stdin into `docker exec -i ... tee`. Nothing is
 *    written to a host dir; the project's `.opencode/opencode.json[c]` is left
 *    untouched. Provider credentials are NOT copied — {@link start} injects them
 *    over the API once the server is ready.
 *
 *  - {@link start} (post-up, after {@link prepareAgentHome}): launches
 *    `opencode serve` by ABSOLUTE PATH (the mounted payload's `launch.sh`), with
 *    the dedicated HOME env and the resolved workspace cwd, binding
 *    `0.0.0.0:<containerPort>` so it is reachable from the host over the
 *    published loopback port. Boboddy's override config is passed as
 *    `OPENCODE_CONFIG_CONTENT` (precedence #6 — inline), ensuring the permission
 *    baseline, step MCPs, and `AGENT_DEFAULT_MODEL` win over the user's
 *    home/project configs. The server is protected by a per-session
 *    `OPENCODE_SERVER_PASSWORD`. Waits for readiness, checks config
 *    diagnostics, injects the user's credentials from the host over the
 *    published port (`opencode-post-readiness.ts`), and returns the
 *    host-facing `agentBaseUrl` plus that password.
 *
 * Because the agent HOME is on overlay, it dies with the container: sessions
 * never share agent state/credentials and no host cleanup of it is required for
 * container runs (see {@link cleanupSessionHome}).
 */

/** In-container path the runtime payload is mounted at is version-specific. */
export const CONTAINER_AGENT_HOME = "/opt/boboddy/agent-home";
/** In-container path the materialized provider config dir is mounted at. */
export const CONTAINER_PROVIDER_DIR = "/opt/boboddy/provider";
/**
 * In-container npm cache dir. MUST live on the container's native overlay
 * filesystem, NOT under {@link CONTAINER_AGENT_HOME} (a macOS host bind mount
 * whose unstable file metadata breaks npm's `_npx` lock verification, causing
 * `ECOMPROMISED: Lock compromised` for every `npx`-based MCP server).
 */
export const CONTAINER_NPM_CACHE_DIR = "/tmp/boboddy-npm-cache";
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

/** Where the in-container opencode process writes its boot log. */
const AGENT_LOG_DIR = `${CONTAINER_AGENT_HOME}/.boboddy-log`;
/** Filename of the in-container opencode serve log within the log directory. */
export const AGENT_SERVE_LOG_FILENAME = "opencode-serve.log";
const AGENT_LOG_PATH = `${AGENT_LOG_DIR}/${AGENT_SERVE_LOG_FILENAME}`;
const AGENT_PID_PATH = `${AGENT_LOG_DIR}/opencode-serve.pid`;

/**
 * In-container seed targets for the agent HOME, computed from
 * {@link CONTAINER_AGENT_HOME}. These MUST match the XDG env set in
 * {@link DevcontainerOpencodeBootstrap.start} (`XDG_CONFIG_HOME` /
 * `XDG_DATA_HOME`) so OpenCode reads what {@link
 * DevcontainerOpencodeBootstrap.prepareAgentHome} writes.
 */
const AGENT_CONFIG_DIR = `${CONTAINER_AGENT_HOME}/.config/opencode`;
const AGENT_CONFIG_PATH = `${AGENT_CONFIG_DIR}/opencode.json`;

export type PlanMountsInput = {
  payload: OpencodeRuntimePayloadLocation;
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
  /** OpenCode version the payload provides; readiness requires an exact match. */
  expectedVersion: string;
  /**
   * Provider env to launch OpenCode with (token under its `tokenEnv`, base URL,
   * etc.) — produced by the RuntimeConfigMaterializer.
   */
  providerEnv: Record<string, string>;
  /**
   * The user's provider credentials, injected from the host over the published
   * port once the server is ready. Every secret in them is masked in error
   * output.
   */
  credentials: readonly OpencodeCredential[];
  /**
   * The step's resolved environment variables (`resolveStepEnv`), appended as
   * `-e` flags after {@link providerEnv}. May carry secrets: log key names
   * only.
   */
  stepEnv?: Readonly<Record<string, string>> | undefined;
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
  /** Basic-auth password the server was started with. */
  serverPassword: string;
  agentLogDirectory: string;
};

/**
 * Pick an ephemeral free loopback port. Exported so the host `no_workspace`
 * bootstrap chooses ports the same way as the published container port.
 */
export function findFreePort(): Promise<number> {
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
 * Run `docker` with the given args, piping `stdin` to the child's stdin and
 * closing it. Unlike {@link execFileAsync}, this can stream content over stdin,
 * which is how {@link DevcontainerOpencodeBootstrap.prepareAgentHome} seeds
 * the global config into the container via `docker exec -i ... tee`.
 *
 * `stdin` may contain secrets (a user config can embed provider keys). It is
 * NEVER logged here and MUST NOT be logged by callers.
 */
function execDockerWithStdin(args: string[], stdin: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `docker ${args[0] ?? ""} exited with code ${String(code)}` +
              (stderr.trim() ? `: ${stderr.trim()}` : ""),
          ),
        );
      }
    });
    child.stdin.end(stdin);
  });
}

export class DevcontainerOpencodeBootstrap {
  /**
   * Compute the bind mounts + host port to publish. Called BEFORE the
   * devcontainer config is patched and the container is launched.
   *
   * The agent HOME is intentionally NOT mounted here — it lives on the
   * container's native overlay filesystem and is created + seeded post-launch by
   * {@link prepareAgentHome}.
   */
  async planMounts(input: PlanMountsInput): Promise<PlanMountsResult> {
    const mounts: DevcontainerBindMount[] = [
      {
        source: input.payload.hostPayloadDir,
        target: input.payload.containerPayloadDir,
        readOnly: true,
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
   * Create the agent HOME on the container's OVERLAY filesystem and seed the
   * user's host global opencode config (`~/.config/opencode/opencode.json[c]`)
   * into `${AGENT_CONFIG_PATH}`, where OpenCode reads it at precedence #2. This
   * avoids touching the user's project repo and needs no host bind mount.
   *
   * Because the agent HOME is NOT bind-mounted (a macOS host bind mount's
   * unstable file metadata breaks tools like npm's `_npx` lock), it cannot be
   * pre-populated on the host. Instead this runs `docker exec` against the
   * ALREADY-RUNNING container: it `mkdir -p`s the config dir on overlay, then
   * pipes the config over stdin into `tee` and `chmod 600`s it.
   *
   * Provider credentials are not copied; {@link start} injects them over the
   * API. Must be called AFTER the container is launched and BEFORE
   * {@link start}. When no global config exists, only the `mkdir` runs.
   */
  async prepareAgentHome(input: {
    containerId: string;
    /** Override host home dir (for tests). Defaults to resolved host home. */
    hostHomeDir?: string | undefined;
  }): Promise<{ hostConfigPath: string | null }> {
    const { hostConfigPath, hostConfigContent } =
      await resolveHostAgentHomeSources({ hostHomeDir: input.hostHomeDir });

    await execFileAsync("docker", [
      "exec",
      input.containerId,
      "sh",
      "-lc",
      `mkdir -p ${shQuote(AGENT_CONFIG_DIR)}`,
    ]);

    if (hostConfigContent !== null) {
      await execDockerWithStdin(
        [
          "exec",
          "-i",
          input.containerId,
          "sh",
          "-lc",
          `tee ${shQuote(AGENT_CONFIG_PATH)} >/dev/null && ` +
            `chmod 600 ${shQuote(AGENT_CONFIG_PATH)}`,
        ],
        hostConfigContent,
      );
    }

    return { hostConfigPath };
  }

  /**
   * Launch `opencode serve` inside the running devcontainer by absolute path and
   * wait for health. Returns the host-facing base URL.
   */
  async start(input: StartInput): Promise<StartResult> {
    const agentBaseUrl = `http://127.0.0.1:${String(input.hostPort)}`;
    const serverPassword = generateServerPassword();

    const envFlags: string[] = [
      "-e",
      `HOME=${CONTAINER_AGENT_HOME}`,
      "-e",
      `XDG_CONFIG_HOME=${CONTAINER_AGENT_HOME}/.config`,
      "-e",
      `XDG_DATA_HOME=${CONTAINER_AGENT_HOME}/.local/share`,
      "-e",
      `XDG_STATE_HOME=${CONTAINER_AGENT_HOME}/.local/state`,
      "-e",
      `XDG_CACHE_HOME=${CONTAINER_AGENT_HOME}/.cache`,
      // Point npm's cache at the container's native overlay fs. The PRIMARY fix
      // for the npm `_npx` lock issue is now that the agent HOME itself lives on
      // overlay (no host bind mount), so npm's `_npx` install lock (libnpmexec
      // `touchLock`) sees stable file metadata and no longer aborts with
      // `ECOMPROMISED: Lock compromised`. This explicit cache override is kept as
      // redundant belt-and-suspenders — harmless now that HOME is on overlay.
      "-e",
      `npm_config_cache=${CONTAINER_NPM_CACHE_DIR}`,
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
    envFlags.push(
      ...buildDockerEnvFlags(input.providerEnv),
      ...buildDockerEnvFlags(input.stepEnv ?? {}),
      "-e",
      `${SERVER_PASSWORD_ENV}=${serverPassword}`,
    );

    const serveCommand =
      // Ensure the overlay HOME base + log dir exist so a missing overlay HOME
      // can't fail serve (the HOME is created by prepareAgentHome, but guard it).
      `mkdir -p ${shQuote(CONTAINER_AGENT_HOME)} ${shQuote(AGENT_LOG_DIR)}; ` +
      `cd ${shQuote(input.workspaceFolder)}; ` +
      `nohup ${shQuote(input.launchWrapperPath)} serve ` +
      `--hostname 0.0.0.0 --port ${String(CONTAINER_OPENCODE_PORT)} ` +
      `${SERVE_LOG_ARGS.map(shQuote).join(" ")} ` +
      `>${shQuote(AGENT_LOG_PATH)} 2>&1 < /dev/null & ` +
      `echo $! >${shQuote(AGENT_PID_PATH)}`;

    logWork("runtime", "Starting in-devcontainer OpenCode", {
      containerId: input.containerId,
      agentBaseUrl,
      launchWrapperPath: input.launchWrapperPath,
      workspaceFolder: input.workspaceFolder,
      providerEnvKeys: Object.keys(input.providerEnv).sort(),
      stepEnvKeys: Object.keys(input.stepEnv ?? {}).sort(),
    });

    await execFileAsync("docker", [
      "exec",
      ...envFlags,
      input.containerId,
      "sh",
      "-lc",
      serveCommand,
    ]);

    const masker = new SecretMasker([
      ...Object.values(input.providerEnv),
      ...Object.values(input.stepEnv ?? {}),
      ...opencodeCredentialSecrets(input.credentials),
      serverPassword,
    ]);
    await this.waitForHealth({
      containerId: input.containerId,
      baseUrl: agentBaseUrl,
      password: serverPassword,
      expectedVersion: input.expectedVersion,
      masker,
    });
    await completeOpencodeBoot({
      baseUrl: agentBaseUrl,
      password: serverPassword,
      workspaceFolder: input.workspaceFolder,
      readLog: () => this.readAgentDiagnosticLines(input.containerId),
      masker,
      credentials: input.credentials,
      logContext: { containerId: input.containerId, baseUrl: agentBaseUrl },
    });

    return { agentBaseUrl, serverPassword, agentLogDirectory: AGENT_LOG_DIR };
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

  /**
   * Remove the session-scoped agent HOME from the host.
   *
   * For CONTAINER runs this is effectively a no-op: the agent HOME lives on the
   * container's overlay filesystem and dies with the container, so there is no
   * host dir to remove (the passed path never held container agent state). The
   * host `no_workspace` path still relies on this to clean its host agent HOME.
   */
  async cleanupSessionHome(sessionAgentHomeDir: string): Promise<void> {
    await cleanupSessionHome(sessionAgentHomeDir);
  }

  private async waitForHealth(input: {
    containerId: string;
    baseUrl: string;
    password: string;
    expectedVersion: string;
    masker: SecretMasker;
  }): Promise<void> {
    const { containerId, baseUrl, masker } = input;
    let attempts = 0;
    const logExcerpt = async (): Promise<string> =>
      formatServeLogExcerpt(await this.readAgentLog(containerId), masker);

    // Fails fast when the in-container process is gone, instead of polling a
    // dead port until the timeout.
    const throwIfProcessDied = async (): Promise<void> => {
      if (
        (await isContainerProcessAlive(containerId, AGENT_PID_PATH)) !== false
      ) {
        return;
      }
      logWorkError(
        "runtime",
        "In-devcontainer OpenCode exited before becoming healthy",
        { containerId, baseUrl, attempts },
      );
      throw new Error(
        `In-devcontainer OpenCode exited before becoming healthy at ${baseUrl}` +
          (await logExcerpt()),
      );
    };

    const result = await waitForReadiness({
      baseUrl,
      password: input.password,
      expectedVersion: input.expectedVersion,
      assertAlive: throwIfProcessDied,
      onNotReady: (attempt, reason) => {
        attempts = attempt;
        logWorkDebug("runtime", "Polling in-devcontainer OpenCode readiness", {
          containerId,
          baseUrl,
          attempt,
          lastError: reason,
        });
      },
    });

    if (result.kind === "ready") {
      logWork("runtime", "In-devcontainer OpenCode healthy", {
        containerId,
        baseUrl,
        attempts: result.attempts,
      });
      return;
    }

    if (result.kind === "wrong-version") {
      logWorkError(
        "runtime",
        "In-devcontainer OpenCode reported an unexpected version",
        {
          containerId,
          baseUrl,
          expectedVersion: input.expectedVersion,
          version: result.version,
        },
      );
      throw new Error(
        `In-devcontainer OpenCode at ${baseUrl} reports version ` +
          `${result.version}, expected ${input.expectedVersion}` +
          (await logExcerpt()),
      );
    }

    logWorkError(
      "runtime",
      "In-devcontainer OpenCode failed to become healthy",
      {
        containerId,
        baseUrl,
        attempts: result.attempts,
        lastError: result.lastReason,
      },
    );
    throw new Error(
      `Timed out waiting for in-devcontainer OpenCode health at ${baseUrl}` +
        (result.lastReason ? `: ${result.lastReason}` : "") +
        (await logExcerpt()),
    );
  }

  private async readAgentLog(containerId: string): Promise<string | null> {
    const stdout = await this.execInContainer(
      containerId,
      `if [ -f ${shQuote(AGENT_LOG_PATH)} ]; then tail -c 4000 ${shQuote(AGENT_LOG_PATH)}; fi`,
    );
    return stdout?.trim() || null;
  }

  private readAgentDiagnosticLines(
    containerId: string,
  ): Promise<string | null> {
    return this.execInContainer(
      containerId,
      `grep -F ${shQuote(CONFIG_DIAGNOSTIC_MESSAGE)} ${shQuote(AGENT_LOG_PATH)} || true`,
    );
  }

  private async execInContainer(
    containerId: string,
    command: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["exec", containerId, "sh", "-lc", command],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return null;
    }
  }
}
