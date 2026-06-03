import { execFile } from "node:child_process";
import { access, chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logWork, logWorkError } from "../../../work/step-execution/application/work-logger";
import type {
  AiContainerLauncher,
  LaunchAiContainerInput,
  LaunchAiContainerResult,
} from "../application/ai-container-launcher";

const execFileAsync = promisify(execFile);
const AI_CONTAINER_PORT = 4096;
const AI_CONTAINER_HEALTH_TIMEOUT_MS = 60_000;
const AI_CONTAINER_HEALTH_INTERVAL_MS = 500;
const DEFAULT_AI_IMAGE = process.env["BOBODDY_BUILT_AI_IMAGE"] ?? "boboddy/ai-worker:local";
const AI_CONTAINER_HEALTH_PATH = "/global/health";
const RUNTIME_HOME_ROOT_DIR = ".boboddy";
const RUNTIME_AI_HOME_DIR = "ai-home";
const RUNTIME_BOBODDY_GITIGNORE_PATH = ".gitignore";
const RUNTIME_BOBODDY_GITIGNORE_CONTENT =
  "*\n.*\n!.gitignore\n!boboddy.jsonc\n";
const PORT_ALLOCATION_RETRIES = 5;
const HEALTH_DIAGNOSTIC_TEXT_LIMIT = 8_000;
const OPENCODE_LOG_FILE_LIMIT = 4;

class AiContainerHealthTimeoutError extends Error {
  constructor(
    message: string,
    readonly details: {
      attempts: number;
      lastStatusCode: number | null;
      lastResponseText: string | null;
      lastError: string | null;
    },
  ) {
    super(message);
  }
}

export function getSessionOpencodeLogDirectory(workspacePath: string): string {
  return path.join(
    getSessionHomePath(workspacePath),
    ".local",
    "share",
    "opencode",
    "log",
  );
}

function getAiImage(): string {
  return (
    process.env["PROJECT_RUNTIME_SESSION_AI_IMAGE"]?.trim() || DEFAULT_AI_IMAGE
  );
}

export function getSessionHomePath(workspacePath: string): string {
  return path.join(workspacePath, RUNTIME_HOME_ROOT_DIR, RUNTIME_AI_HOME_DIR);
}

export async function ensureBoboddyRuntimeWorkspaceRoot(
  workspacePath: string,
): Promise<void> {
  const boboddyRootPath = path.join(workspacePath, RUNTIME_HOME_ROOT_DIR);
  await mkdir(boboddyRootPath, { recursive: true });
  await writeFile(
    path.join(boboddyRootPath, RUNTIME_BOBODDY_GITIGNORE_PATH),
    RUNTIME_BOBODDY_GITIGNORE_CONTENT,
  );
}

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

function truncateText(value: string, limit = HEALTH_DIAGNOSTIC_TEXT_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...<truncated ${String(value.length - limit)} chars>`;
}

async function captureCommandOutput(
  command: string,
  args: string[],
): Promise<{
  ok: boolean;
  output: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args);
    return {
      ok: true,
      output: truncateText([stdout, stderr].filter(Boolean).join("\n").trim()),
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      "stderr" in error
    ) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        output: truncateText(
          [err.message, err.stdout, err.stderr].filter(Boolean).join("\n").trim(),
        ),
      };
    }

    return {
      ok: false,
      output: truncateText(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function captureOpencodeLogSnapshot(
  workspacePath: string,
): Promise<
  Array<{
    file: string;
    content: string;
  }>
> {
  const logDir = getSessionOpencodeLogDirectory(workspacePath);

  try {
    const entries = await readdir(logDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
      .slice(-OPENCODE_LOG_FILE_LIMIT);

    return await Promise.all(
      files.map(async (file) => ({
        file,
        content: truncateText(
          await readFile(path.join(logDir, file), "utf8").catch((error) => {
            return `Failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`;
          }),
        ),
      })),
    );
  } catch (error) {
    return [
      {
        file: "<opencode-log-dir>",
        content: `Unavailable: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}

async function logAiContainerDiagnostics(input: {
  sessionId: string;
  containerId: string;
  workspacePath: string;
  hostPort: number;
  image: string;
  baseUrl: string;
  failure: unknown;
}) {
  const [inspect, portBindings, processList, logs, state, exitCode, opencodeLogs] =
    await Promise.all([
      captureCommandOutput("docker", ["inspect", input.containerId]),
      captureCommandOutput("docker", [
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        input.containerId,
      ]),
      captureCommandOutput("docker", [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `id=${input.containerId}`,
      ]),
      captureCommandOutput("docker", ["logs", "--timestamps", input.containerId]),
      captureCommandOutput("docker", [
        "inspect",
        "--format",
        "{{json .State}}",
        input.containerId,
      ]),
      captureCommandOutput("docker", [
        "inspect",
        "--format",
        "{{.State.ExitCode}}",
        input.containerId,
      ]),
      captureOpencodeLogSnapshot(input.workspacePath),
    ]);

  const failureDetails =
    input.failure instanceof AiContainerHealthTimeoutError
      ? input.failure.details
      : undefined;

  logWorkError("runtime", "AI container launch diagnostics", {
    sessionId: input.sessionId,
    aiContainerId: input.containerId,
    aiImage: input.image,
    aiBaseUrl: input.baseUrl,
    hostPort: input.hostPort,
    healthPath: AI_CONTAINER_HEALTH_PATH,
    failureMessage:
      input.failure instanceof Error ? input.failure.message : String(input.failure),
    healthAttempts: failureDetails?.attempts,
    lastHealthStatusCode: failureDetails?.lastStatusCode,
    lastHealthResponseText: failureDetails?.lastResponseText,
    lastHealthError: failureDetails?.lastError,
    dockerInspectOk: inspect.ok,
    dockerInspect: inspect.output,
    dockerPortBindingsOk: portBindings.ok,
    dockerPortBindings: portBindings.output,
    dockerPsOk: processList.ok,
    dockerPs: processList.output,
    dockerLogsOk: logs.ok,
    dockerLogs: logs.output,
    dockerStateOk: state.ok,
    dockerState: state.output,
    dockerExitCodeOk: exitCode.ok,
    dockerExitCode: exitCode.output,
    opencodeLogs,
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + AI_CONTAINER_HEALTH_TIMEOUT_MS;
  let attempts = 0;
  let lastStatusCode: number | null = null;
  let lastResponseText: string | null = null;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    attempts += 1;

    try {
      const response = await fetch(`${baseUrl}${AI_CONTAINER_HEALTH_PATH}`);
      lastStatusCode = response.status;

      if (response.ok) {
        return;
      }

      lastResponseText = truncateText(await response.text());
      lastError = null;
    } catch (error) {
      // The container may still be starting.
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, AI_CONTAINER_HEALTH_INTERVAL_MS);
    });
  }

  throw new AiContainerHealthTimeoutError(
    `Timed out waiting for AI container health at ${baseUrl}`,
    {
      attempts,
      lastStatusCode,
      lastResponseText,
      lastError,
    },
  );
}

export class DockerAiContainerLauncher implements AiContainerLauncher {
  async launch(
    input: LaunchAiContainerInput,
  ): Promise<LaunchAiContainerResult> {
    const image = getAiImage();
    const sessionHomePath = getSessionHomePath(input.workspacePath);
    await ensureBoboddyRuntimeWorkspaceRoot(input.workspacePath);
    const hostOpencodeConfigPath = path.join(
      os.homedir(),
      ".config",
      "opencode",
    );
    const hostOpencodeDataPath = path.join(
      os.homedir(),
      ".local",
      "share",
      "opencode",
    );
    const hasHostOpencodeConfig = await access(hostOpencodeConfigPath)
      .then(() => true)
      .catch(() => false);
    const hasHostOpencodeData = await access(hostOpencodeDataPath)
      .then(() => true)
      .catch(() => false);

    await mkdir(path.join(sessionHomePath, ".local", "share", "opencode"), {
      recursive: true,
    });
    await mkdir(path.join(sessionHomePath, ".local", "state"), {
      recursive: true,
    });
    await chmod(sessionHomePath, 0o777);
    await chmod(path.join(sessionHomePath, ".local"), 0o777);
    await chmod(path.join(sessionHomePath, ".local", "share"), 0o777);
    await chmod(
      path.join(sessionHomePath, ".local", "share", "opencode"),
      0o777,
    );
    await chmod(path.join(sessionHomePath, ".local", "state"), 0o777);

    const baseArgs = [
      "-v",
      `${input.workspacePath}:/workspace`,
      "-v",
      `${sessionHomePath}:/home/node`,
      "-w",
      "/workspace",
      "-e",
      "HOME=/home/node",
      "--label",
      `boboddy.ai-project-id=${input.projectId}`,
      "--label",
      `boboddy.ai-project-runtime-session-id=${input.sessionId}`,
      "--label",
      `boboddy.ai-requested-by-user-id=${input.requestedByUserId}`,
      "--label",
      "boboddy.runtime-role=ai",
    ];

    for (const [key, value] of Object.entries(input.extraEnv ?? {})) {
      baseArgs.push("-e", `${key}=${value}`);
    }

    if (hasHostOpencodeConfig) {
      baseArgs.push("-v", `${hostOpencodeConfigPath}:/home/node/.config/opencode`);
    }

    if (hasHostOpencodeData) {
      baseArgs.push("-v", `${hostOpencodeDataPath}:/opencode-host-share:ro`);
    }

    // On Linux, host.docker.internal is not automatically resolvable inside
    // containers the way it is on macOS/Windows Docker Desktop.
    if (os.platform() === "linux") {
      baseArgs.push("--add-host", "host.docker.internal:host-gateway");
    }

    baseArgs.push(image);

    let lastError: unknown;
    for (let attempt = 0; attempt < PORT_ALLOCATION_RETRIES; attempt++) {
      const hostPort = await findFreePort();
      const args = [
        "create",
        "-p",
        `127.0.0.1:${String(hostPort)}:${String(AI_CONTAINER_PORT)}`,
        ...baseArgs,
      ];

      let containerId: string;
      try {
        logWork("runtime", "Creating AI container", {
          sessionId: input.sessionId,
          image,
          hostPort,
          aiContainerPort: AI_CONTAINER_PORT,
          workspacePath: input.workspacePath,
          sessionHomePath,
          additionalNetworks: input.additionalNetworks ?? [],
          extraEnvKeys: Object.keys(input.extraEnv ?? {}).sort(),
          hasHostOpencodeConfig,
          hasHostOpencodeData,
          portAllocationAttempt: attempt + 1,
          portAllocationRetryLimit: PORT_ALLOCATION_RETRIES,
        });
        const { stdout } = await execFileAsync("docker", args);
        containerId = stdout.trim();
      } catch (error) {
        // Port may have been claimed between findFreePort and docker create; retry.
        lastError = error;
        logWorkError("runtime", "AI container create failed; retrying", {
          sessionId: input.sessionId,
          image,
          hostPort,
          portAllocationAttempt: attempt + 1,
          portAllocationRetryLimit: PORT_ALLOCATION_RETRIES,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (!containerId) {
        throw new Error("Failed to create AI container");
      }

      try {
        logWork("runtime", "AI container created", {
          sessionId: input.sessionId,
          aiContainerId: containerId,
          image,
          hostPort,
        });

        for (const network of input.additionalNetworks ?? []) {
          await execFileAsync("docker", ["network", "connect", network, containerId]);
        }

        if ((input.additionalNetworks ?? []).length > 0) {
          logWork("runtime", "Connected AI container to additional networks", {
            sessionId: input.sessionId,
            aiContainerId: containerId,
            additionalNetworks: input.additionalNetworks,
          });
        }

        await execFileAsync("docker", ["start", containerId]);

        const baseUrl = `http://127.0.0.1:${String(hostPort)}`;
        logWork("runtime", "Waiting for AI container health", {
          sessionId: input.sessionId,
          aiContainerId: containerId,
          aiBaseUrl: baseUrl,
          aiImage: image,
          healthPath: AI_CONTAINER_HEALTH_PATH,
          healthTimeoutMs: AI_CONTAINER_HEALTH_TIMEOUT_MS,
        });
        await waitForHealth(baseUrl);

        logWork("runtime", "AI container became healthy", {
          sessionId: input.sessionId,
          aiContainerId: containerId,
          aiBaseUrl: baseUrl,
          aiImage: image,
          hostPort,
        });

        return {
          containerId,
          baseUrl,
          image,
          opencodeLogDirectory: getSessionOpencodeLogDirectory(
            input.workspacePath,
          ),
          metadata: {
            port: hostPort,
          },
        };
      } catch (error) {
        await logAiContainerDiagnostics({
          sessionId: input.sessionId,
          containerId,
          workspacePath: input.workspacePath,
          hostPort,
          image,
          baseUrl: `http://127.0.0.1:${String(hostPort)}`,
          failure: error,
        });
        await this.stop(containerId);
        throw error;
      }
    }

    throw lastError ?? new Error("Failed to allocate a free port for the AI container");
  }

  async stop(containerId: string): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "-f", containerId]);
    } catch {
      // Ignore missing or already-stopped containers.
    }
  }
}
