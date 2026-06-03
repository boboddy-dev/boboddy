import { execFile } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + AI_CONTAINER_HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}${AI_CONTAINER_HEALTH_PATH}`);

      if (response.ok) {
        return;
      }
    } catch {
      // The container may still be starting.
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, AI_CONTAINER_HEALTH_INTERVAL_MS);
    });
  }

  throw new Error(`Timed out waiting for AI container health at ${baseUrl}`);
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
      "--rm",
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
        const { stdout } = await execFileAsync("docker", args);
        containerId = stdout.trim();
      } catch (error) {
        // Port may have been claimed between findFreePort and docker create; retry.
        lastError = error;
        continue;
      }

      if (!containerId) {
        throw new Error("Failed to create AI container");
      }

      try {
        for (const network of input.additionalNetworks ?? []) {
          await execFileAsync("docker", ["network", "connect", network, containerId]);
        }

        await execFileAsync("docker", ["start", containerId]);

        const baseUrl = `http://127.0.0.1:${String(hostPort)}`;
        await waitForHealth(baseUrl);

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
