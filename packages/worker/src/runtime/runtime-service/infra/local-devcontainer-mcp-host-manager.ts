import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OpenCodePlugins } from "@boboddy/sdk/opencode-plugin";
import type { ProjectRuntimeSessionExecutionTarget } from "../domain/project-runtime-session-execution-target";
import { readLocalExecutionMetadata, toRuntimeProxyBinaryArchitecture, delay } from "./local-devcontainer-port-forward-manager-support";
import {
  MCP_HOST_BINARY_PATH,
  MCP_HOST_BOOT_WAIT_MS,
  MCP_HOST_DIRECTORY_PATH,
  MCP_HOST_HEALTH_POLL_MS,
  MCP_HOST_HEALTH_TIMEOUT_MS,
  MCP_HOST_LOG_PATH,
  MCP_HOST_PID_PATH,
  MCP_HOST_PLUGINS_JSON_PATH,
} from "./local-devcontainer-mcp-host-manager-support";

const execFileAsync = promisify(execFile);

/**
 * Cache of loaded binary data keyed by architecture, shared across manager instances.
 */
const localMcpHostBinaryCache = new Map<string, Promise<Uint8Array>>();

/**
 * Inject bytes into a container file, mirroring injectIntoContainer in the port-forward manager.
 */
async function injectIntoContainer(
  containerId: string,
  data: Uint8Array | string,
  dirPath: string,
  filePath: string,
): Promise<void> {
  const bytes =
    typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("docker", [
      "exec",
      "-i",
      containerId,
      "sh",
      "-c",
      `mkdir -p '${dirPath}' && cat > '${filePath}.tmp' && mv '${filePath}.tmp' '${filePath}'`,
    ]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") reject(err);
    });
    proc.on("error", reject);
    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(
          new Error(
            `Failed to inject file into container at ${filePath}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      } else {
        resolve();
      }
    });
    proc.stdin.end(bytes);
  });
}

/**
 * Read the startup log from inside the container.
 */
async function readStartupLog(
  containerId: string,
  logPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      containerId,
      "sh",
      "-lc",
      `if [ -f '${logPath}' ]; then cat '${logPath}'; fi`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Allocate a free port in the devcontainer by asking the OS to bind :0.
 *
 * We run a tiny sh snippet that binds a TCP socket and prints the port.
 * If that fails (container lacks socat/python), fall back to a static pick.
 */
async function allocateFreePortInContainer(containerId: string): Promise<number> {
  // Try python3 (available in most devcontainers via the AI base image)
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      containerId,
      "python3",
      "-c",
      "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()",
    ]);
    const port = Number(stdout.trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
  } catch {
    // python3 not available — fall back
  }

  // Static fallback: pick a port in the MCP host range by finding an unused one
  // This is a best-effort approach; the port may collide but is unlikely in practice.
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      containerId,
      "sh",
      "-lc",
      // Find a port in range 40000–49999 that nothing is listening on
      `for port in $(seq 40000 49999); do (cat /dev/null > /dev/tcp/127.0.0.1/$port) 2>/dev/null || { echo $port; break; }; done`,
    ]);
    const port = Number(stdout.trim());
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  } catch {
    // Ignore
  }

  // Last resort: fixed port with low collision probability
  return 40_751;
}

/**
 * Poll GET http://127.0.0.1:<port>/health inside the container until it returns 200.
 */
async function waitForMcpHostHealth(
  containerId: string,
  port: number,
): Promise<void> {
  const deadline = Date.now() + MCP_HOST_HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("docker", [
        "exec",
        containerId,
        "sh",
        "-lc",
        `curl -sf http://127.0.0.1:${port}/health && echo OK`,
      ]);
      if (stdout.includes("OK")) return;
    } catch {
      // Not ready yet
    }
    await delay(MCP_HOST_HEALTH_POLL_MS);
  }

  const log = await readStartupLog(containerId, MCP_HOST_LOG_PATH);
  throw new Error(
    `MCP host failed to become healthy within ${MCP_HOST_HEALTH_TIMEOUT_MS}ms${log ? `: ${log}` : ""}`,
  );
}

/**
 * Load the cross-compiled boboddy Linux binary data, using the same candidate
 * paths as the port-forward manager.
 */
async function loadMcpHostBinaryData(
  architecture: string,
): Promise<Uint8Array> {
  const binaryName = `boboddy-linux-${architecture}`;
  const candidatePaths = [
    // Production: sibling of the running CLI binary
    path.join(path.dirname(process.execPath), binaryName),
    // Dev: built CLI binaries in apps/cli/dist relative to this source file
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../dist",
      binaryName,
    ),
  ];

  for (const candidate of candidatePaths) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      return new Uint8Array(await file.arrayBuffer());
    }
  }

  throw new Error(
    `Could not find Linux CLI binary "${binaryName}". Tried:\n` +
      candidatePaths.map((p) => `  - ${p}`).join("\n") +
      `\nIn dev, run 'bun run --filter @boboddy/cli build' to produce the binaries.`,
  );
}

async function getMcpHostBinaryData(containerId: string): Promise<Uint8Array> {
  const { stdout } = await execFileAsync("docker", [
    "exec",
    containerId,
    "uname",
    "-m",
  ]);
  const arch = toRuntimeProxyBinaryArchitecture(stdout);
  const cached = localMcpHostBinaryCache.get(arch);
  if (cached) return cached;
  const promise = loadMcpHostBinaryData(arch);
  localMcpHostBinaryCache.set(arch, promise);
  return promise;
}

/**
 * Manages the lifecycle of the MCP host process inside the devcontainer.
 *
 * Mirrors LocalDevcontainerPortForwardManager: injects the cross-compiled binary,
 * writes a plugins.json config, starts the process with nohup, and polls /health.
 */
export class LocalDevcontainerMcpHostManager {
  /**
   * Ensure the MCP host is running in the devcontainer.
   *
   * @returns The port the MCP host is listening on.
   */
  async ensure(
    executionTarget: ProjectRuntimeSessionExecutionTarget,
    plugins: OpenCodePlugins,
  ): Promise<number> {
    const { containerId } = readLocalExecutionMetadata(executionTarget);

    const [binaryData, port] = await Promise.all([
      getMcpHostBinaryData(containerId),
      allocateFreePortInContainer(containerId),
    ]);

    const pluginsJson = JSON.stringify(plugins, null, 2) + "\n";

    // Inject binary and plugins config into the devcontainer
    await Promise.all([
      injectIntoContainer(containerId, binaryData, MCP_HOST_DIRECTORY_PATH, MCP_HOST_BINARY_PATH),
      injectIntoContainer(containerId, pluginsJson, MCP_HOST_DIRECTORY_PATH, MCP_HOST_PLUGINS_JSON_PATH),
    ]);

    // Kill any previously running instance, then start a fresh one
    await execFileAsync("docker", [
      "exec",
      containerId,
      "sh",
      "-lc",
      [
        `if [ -f '${MCP_HOST_PID_PATH}' ]; then`,
        `  pid=$(cat '${MCP_HOST_PID_PATH}')`,
        `  kill "$pid" 2>/dev/null || true`,
        `  rm -f '${MCP_HOST_PID_PATH}'`,
        `fi`,
        `chmod +x '${MCP_HOST_BINARY_PATH}'`,
        `nohup '${MCP_HOST_BINARY_PATH}' mcp-host`,
        `  --workspace /workspace`,
        `  --port ${port}`,
        `  --plugins-json '${MCP_HOST_PLUGINS_JSON_PATH}'`,
        `  >'${MCP_HOST_LOG_PATH}' 2>&1 < /dev/null &`,
        `echo $! >'${MCP_HOST_PID_PATH}'`,
      ].join(" "),
    ]);

    await delay(MCP_HOST_BOOT_WAIT_MS);

    // Verify the process is still alive
    try {
      await execFileAsync("docker", [
        "exec",
        containerId,
        "sh",
        "-lc",
        `pid=$(cat '${MCP_HOST_PID_PATH}'); kill -0 "$pid"`,
      ]);
    } catch {
      const log = await readStartupLog(containerId, MCP_HOST_LOG_PATH);
      throw new Error(
        log
          ? `MCP host failed to start: ${log}`
          : "MCP host failed to start (no log available)",
      );
    }

    // Wait for /health to succeed — the host needs to install npm packages
    await waitForMcpHostHealth(containerId, port);

    return port;
  }

  /**
   * Stop the MCP host process and remove its working directory.
   */
  async stop(
    executionTarget: ProjectRuntimeSessionExecutionTarget,
  ): Promise<void> {
    const { containerId } = readLocalExecutionMetadata(executionTarget);

    try {
      await execFileAsync("docker", [
        "exec",
        containerId,
        "sh",
        "-lc",
        `if [ -f '${MCP_HOST_PID_PATH}' ]; then pid=$(cat '${MCP_HOST_PID_PATH}'); kill "$pid" 2>/dev/null || true; fi; rm -rf '${MCP_HOST_DIRECTORY_PATH}'`,
      ]);
    } catch {
      // Ignore — container may already be stopped
    }
  }
}
