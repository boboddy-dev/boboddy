import { execFile } from "node:child_process";
import { access, chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GenericContainer, Wait } from "testcontainers";
import type {
  AiContainerLauncher,
  LaunchAiContainerInput,
  LaunchAiContainerResult,
} from "../../../../../../src/runtime/runtime-service/application/ai-container-launcher";
import {
  buildAiContainerBaseArgs,
  ensureBoboddyRuntimeWorkspaceRoot,
  getSessionHomePath,
  getSessionOpencodeLogDirectory,
  resolveAiImage,
  resolveWorkspaceOwnership,
} from "../../../../../../src/runtime/runtime-service/infra/docker-ai-container-launcher";
import type { ContainerRegistry } from "./container-registry";

const execFileAsync = promisify(execFile);

const AI_CONTAINER_PORT = 4096;
const AI_READY_LOG = "opencode server listening on";
const AI_STARTUP_TIMEOUT_MS = 120_000;
// The opencode server logs AI_READY_LOG when it binds the port, but on slower
// runners (notably Linux CI) the HTTP stack is not necessarily ready to serve
// the first request by the time that line is emitted. The production launcher
// (DockerAiContainerLauncher) gates readiness on an actual HTTP health probe
// against this path; mirror that here so session.create does not race an
// unready server and fail (which previously surfaced as processedCount 0 in
// CI). The health endpoint returns 200 once opencode can serve requests.
const AI_HEALTH_PATH = "/global/health";

type BindMount = { source: string; target: string; mode: "rw" | "ro" };

/**
 * testcontainers-backed AiContainerLauncher used only in integration tests.
 *
 * It deliberately reuses the production base-arg builder
 * (buildAiContainerBaseArgs) so the container is configured identically to
 * production (mounts, user, workdir, env), then translates those flat docker
 * args into the GenericContainer builder API. Containers are tracked in the
 * provided registry and reaped by testcontainers' Ryuk.
 */
export class TestcontainersAiContainerLauncher implements AiContainerLauncher {
  constructor(private readonly registry: ContainerRegistry) {}

  async launch(input: LaunchAiContainerInput): Promise<LaunchAiContainerResult> {
    const image = resolveAiImage().ref;
    await assertImagePresent(image);

    const sessionHomePath = getSessionHomePath(input.workspacePath);
    await ensureBoboddyRuntimeWorkspaceRoot(input.workspacePath);
    const workspaceOwnership = await resolveWorkspaceOwnership(
      input.workspacePath,
    );

    // Mirror the production launcher's session-home preparation: the AI
    // container runs as the workspace owner (uid:gid) and writes into
    // /home/node (bind-mounted to the session home), so these dirs must exist
    // and be world-writable before the container starts. Without this the
    // entrypoint fails with "mkdir: cannot create directory '/home/node/.local'".
    await mkdir(path.join(sessionHomePath, ".local", "share", "opencode"), {
      recursive: true,
    });
    await mkdir(path.join(sessionHomePath, ".local", "state"), {
      recursive: true,
    });
    await chmod(sessionHomePath, 0o777);
    await chmod(path.join(sessionHomePath, ".local"), 0o777);
    await chmod(path.join(sessionHomePath, ".local", "share"), 0o777);
    await chmod(path.join(sessionHomePath, ".local", "share", "opencode"), 0o777);
    await chmod(path.join(sessionHomePath, ".local", "state"), 0o777);

    // The AI launcher mounts the host opencode config so OpenCode picks up the
    // fake AI provider baseURL. The test overrides HOME to a temp dir and
    // seeds the fake provider config there. IMPORTANT: on macOS os.homedir()
    // ignores process.env.HOME (it reads the OS user database), so we must
    // resolve from process.env.HOME explicitly to honor the test's override.
    const home = process.env["HOME"]?.trim() || os.homedir();
    const hostOpencodeConfigPath = path.join(home, ".config", "opencode");
    const hasHostOpencodeConfig = await pathExists(hostOpencodeConfigPath);

    const baseArgs = buildAiContainerBaseArgs({
      workspacePath: input.workspacePath,
      sessionHomePath,
      workspaceOwnership,
      projectId: input.projectId,
      sessionId: input.sessionId,
      requestedByUserId: input.requestedByUserId,
      extraEnv: input.extraEnv,
      hasHostOpencodeConfig,
      hostOpencodeConfigPath,
      hasHostOpencodeData: false,
      hostOpencodeDataPath: "",
      image,
    });

    // buildAiContainerBaseArgs appends the image as the final element;
    // GenericContainer takes the image separately.
    const createArgs = baseArgs.slice(0, -1);

    const container = new GenericContainer(image)
      .withExposedPorts(AI_CONTAINER_PORT)
      .withStartupTimeout(AI_STARTUP_TIMEOUT_MS)
      // Wait for both signals before considering the container ready:
      //   1. the "listening" log line opencode emits when it binds the port, and
      //   2. a successful HTTP health probe against the mapped port, so we know
      //      the server is actually serving requests (not just bound).
      // Waiting on the log alone leaves a window where session.create can hit an
      // unready HTTP stack and fail its retry budget — the cause of the CI-only
      // processedCount 0 failures. The HTTP probe closes that window and matches
      // the production launcher's health gate.
      .withWaitStrategy(
        Wait.forAll([
          Wait.forLogMessage(AI_READY_LOG),
          Wait.forHttp(AI_HEALTH_PATH, AI_CONTAINER_PORT).forStatusCode(200),
        ]).withStartupTimeout(AI_STARTUP_TIMEOUT_MS),
      )
      .withLabels({
        "boboddy.runtime-role": "ai",
        "boboddy.ai-project-runtime-session-id": input.sessionId,
      });

    applyDockerArgsToBuilder(container, createArgs);

    // Always map host.docker.internal to the host gateway. The AI container is
    // attached to extra Docker networks (the devcontainer's network) after
    // start; on multi-network containers Docker Desktop does not reliably
    // auto-inject host.docker.internal, so pin it explicitly. This is how the
    // container reaches the host-side fake AI server.
    container.withExtraHosts([
      { host: "host.docker.internal", ipAddress: "host-gateway" },
    ]);

    const started = await container.start();
    this.registry.register(started);

    const hostPort = started.getMappedPort(AI_CONTAINER_PORT);
    const baseUrl = `http://127.0.0.1:${String(hostPort)}`;

    return {
      containerId: started.getId(),
      baseUrl,
      image,
      opencodeLogDirectory: getSessionOpencodeLogDirectory(input.workspacePath),
      metadata: { port: hostPort },
    };
  }

  async stop(containerId: string): Promise<void> {
    await this.registry.stop(containerId);
  }
}

function applyDockerArgsToBuilder(
  container: GenericContainer,
  createArgs: string[],
): void {
  const bindMounts: BindMount[] = [];
  const tmpfs: Record<string, string> = {};
  const envVars: Record<string, string> = {};

  for (let i = 0; i < createArgs.length; i++) {
    const flag = createArgs[i];
    const value = createArgs[i + 1];

    if (flag === "--user" && value) {
      container.withUser(value);
      i++;
    } else if (flag === "-w" && value) {
      container.withWorkingDir(value);
      i++;
    } else if (flag === "-e" && value) {
      const eqIdx = value.indexOf("=");
      if (eqIdx !== -1) {
        envVars[value.slice(0, eqIdx)] = value.slice(eqIdx + 1);
      }
      i++;
    } else if (flag === "--tmpfs" && value) {
      // Format: /path[:options]
      const colonIdx = value.indexOf(":");
      const target = colonIdx === -1 ? value : value.slice(0, colonIdx);
      const options = colonIdx === -1 ? "" : value.slice(colonIdx + 1);
      tmpfs[target] = options;
      i++;
    } else if (flag === "-v" && value) {
      const colonIdx = value.indexOf(":");
      if (colonIdx !== -1) {
        const source = value.slice(0, colonIdx);
        const rest = value.slice(colonIdx + 1);
        const roIdx = rest.lastIndexOf(":");
        const target = roIdx !== -1 ? rest.slice(0, roIdx) : rest;
        const readOnly = roIdx !== -1 && rest.slice(roIdx + 1) === "ro";
        bindMounts.push({ source, target, mode: readOnly ? "ro" : "rw" });
      }
      i++;
    }
    // --label / --add-host handled separately by the caller.
  }

  if (Object.keys(envVars).length > 0) {
    container.withEnvironment(envVars);
  }
  if (bindMounts.length > 0) {
    container.withBindMounts(bindMounts);
  }
  if (Object.keys(tmpfs).length > 0) {
    container.withTmpFs(tmpfs);
  }
}

async function assertImagePresent(image: string): Promise<void> {
  try {
    await execFileAsync("docker", [
      "image",
      "inspect",
      image,
      "--format",
      ".",
    ]);
  } catch {
    throw new Error(
      `AI worker image not found locally: ${image}\n` +
        `Pull it first with: docker pull ${image}`,
    );
  }
}

async function pathExists(p: string): Promise<boolean> {
  return access(p)
    .then(() => true)
    .catch(() => false);
}
