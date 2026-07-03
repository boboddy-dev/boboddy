import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { GenericContainer, Wait } from "testcontainers";
import type {
  DevcontainerLauncher,
  LaunchDevcontainerInput,
  LaunchDevcontainerResult,
  ResolveDevcontainerConfigInput,
} from "../../../../../../src/runtime/runtime-service/application/devcontainer-launcher";
import type { ContainerRegistry } from "./container-registry";

const DEVCONTAINER_CONFIG_CANDIDATES = [
  ".devcontainer/devcontainer.json",
  "devcontainer.json",
] as const;

const DEFAULT_IMAGE = "mcr.microsoft.com/devcontainers/base:debian";
const STARTUP_TIMEOUT_MS = 120_000;
const READY_MARKER = "boboddy-devcontainer-ready";

type ParsedDevcontainerConfig = {
  image?: string;
  /** Long-form bind mount strings injected by the orchestrator pre-`up`. */
  mounts?: string[];
  /** host:container port publishes injected by the orchestrator pre-`up`. */
  appPort?: (string | number) | (string | number)[];
};

type ParsedBindMount = {
  source: string;
  target: string;
  readOnly: boolean;
};

/**
 * testcontainers-backed DevcontainerLauncher for the SINGLE-CONTAINER model.
 *
 * In the single-container runtime there is no separate AI container: OpenCode
 * runs INSIDE this devcontainer. The orchestrator prepares that by patching the
 * cloned devcontainer.json BEFORE launch with:
 *   - top-level `mounts` (the Boboddy OpenCode runtime payload, the
 *     session-scoped agent HOME, and optionally a provider config dir), and
 *   - an `appPort` publish (127.0.0.1:<hostPort>:4096) so the in-container
 *     OpenCode HTTP server is reachable from the host worker over loopback.
 *
 * Rather than driving the @devcontainers/cli (slow, requires the bundled CLI
 * script), this launcher honors exactly those patched fields so the in-container
 * OpenCode bootstrap can mount its payload and the host can reach the agent —
 * mirroring the essential behaviour `devcontainers-cli up` would provide. The
 * workspace is bind-mounted at the single-container convention
 * `/workspaces/<basename>` (matching the orchestrator's resolved
 * `agentWorkspaceFolder` when the config omits an explicit workspaceFolder).
 * Containers are tracked for reaping.
 */
export class TestcontainersDevcontainerLauncher
  implements DevcontainerLauncher
{
  constructor(private readonly registry: ContainerRegistry) {}

  async resolveConfigPath(
    input: ResolveDevcontainerConfigInput,
  ): Promise<string> {
    for (const candidate of DEVCONTAINER_CONFIG_CANDIDATES) {
      try {
        await access(path.join(input.workspacePath, candidate));
        return candidate;
      } catch {
        // Try next candidate.
      }
    }
    throw new Error(
      `No devcontainer spec found in ${input.workspacePath}. ` +
        `Expected .devcontainer/devcontainer.json or devcontainer.json`,
    );
  }

  async launch(
    input: LaunchDevcontainerInput,
  ): Promise<LaunchDevcontainerResult> {
    const config = await this.readConfig(
      path.join(input.workspacePath, input.devcontainerConfigPath),
    );
    const image = config.image?.trim() || DEFAULT_IMAGE;
    const workspaceTarget = `/workspaces/${path.basename(input.workspacePath)}`;

    // The orchestrator's mount injection (runtime payload, agent HOME,
    // provider config) is applied here so the in-container OpenCode bootstrap
    // can launch from the mounted payload — there is no second container.
    const injectedMounts = parseBindMounts(config.mounts ?? []);

    let container = new GenericContainer(image)
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      // Keep the container alive (base devcontainer images otherwise exit) and
      // emit a marker line so we can wait on it. The base image exposes no
      // ports, so a port-based wait strategy would never resolve.
      .withEntrypoint([])
      .withCommand(["sh", "-c", `echo ${READY_MARKER} && exec sleep infinity`])
      .withBindMounts([
        { source: input.workspacePath, target: workspaceTarget, mode: "rw" },
        ...injectedMounts.map((mount) => ({
          source: mount.source,
          target: mount.target,
          mode: mount.readOnly ? ("ro" as const) : ("rw" as const),
        })),
      ])
      .withWorkingDir(workspaceTarget)
      .withWaitStrategy(
        Wait.forLogMessage(READY_MARKER).withStartupTimeout(STARTUP_TIMEOUT_MS),
      )
      .withLabels({
        "boboddy.runtime-role": "project",
        "boboddy.project-runtime-session-id": input.sessionId,
      })
      // Map host.docker.internal to the Docker host gateway so the in-container
      // OpenCode can reach the host-side fake AI server. macOS/Windows Docker
      // Desktop provide this alias natively, but on Linux (CI) it does not
      // resolve unless we add it explicitly. Without this the agent cannot reach
      // the fake AI, never submits findings, and the run polls until the test
      // timeout.
      .withExtraHosts([
        { host: "host.docker.internal", ipAddress: "host-gateway" },
      ]);

    // Publish the OpenCode host port the orchestrator chose. The injected
    // appPort spec is `127.0.0.1:<hostPort>:<containerPort>`; bind the fixed
    // host port so the worker reaches the in-container agent over loopback.
    const portBinding = parseAppPort(config.appPort);
    if (portBinding) {
      container = container.withExposedPorts({
        container: portBinding.containerPort,
        host: portBinding.hostPort,
      });
    }

    const started = await container.start();
    this.registry.register(started);

    return {
      containerId: started.getId(),
      metadata: { image, workspaceFolder: workspaceTarget },
    };
  }

  async stop(containerId: string): Promise<void> {
    await this.registry.stop(containerId);
  }

  private async readConfig(
    configPath: string,
  ): Promise<ParsedDevcontainerConfig> {
    try {
      const raw = await readFile(configPath, "utf8");
      // devcontainer.json permits // comments; strip them for JSON.parse.
      const stripped = raw.replace(/\/\/[^\n]*/g, "");
      return JSON.parse(stripped) as ParsedDevcontainerConfig;
    } catch {
      return {};
    }
  }
}

/** Parse long-form `type=bind,source=...,target=...[,readonly]` mount strings. */
function parseBindMounts(mounts: readonly string[]): ParsedBindMount[] {
  const parsed: ParsedBindMount[] = [];
  for (const value of mounts) {
    let source: string | undefined;
    let target: string | undefined;
    let readOnly = false;
    for (const segment of value.split(",")) {
      const [key, ...rest] = segment.split("=");
      const val = rest.join("=").trim();
      if (key === "source" || key === "src") {
        source = val;
      } else if (key === "target" || key === "destination" || key === "dst") {
        target = val;
      } else if (segment.trim() === "readonly" || segment.trim() === "ro") {
        readOnly = true;
      }
    }
    if (source && target) {
      parsed.push({ source, target, readOnly });
    }
  }
  return parsed;
}

/**
 * Parse the orchestrator's injected appPort publish
 * (`127.0.0.1:<hostPort>:<containerPort>`) into the explicit host/container
 * ports testcontainers needs. Returns null when no Boboddy publish is present.
 */
function parseAppPort(
  appPort: ParsedDevcontainerConfig["appPort"],
): { hostPort: number; containerPort: number } | null {
  const specs = Array.isArray(appPort)
    ? appPort
    : appPort === undefined
      ? []
      : [appPort];
  for (const spec of specs) {
    if (typeof spec !== "string") {
      continue;
    }
    // Expect `127.0.0.1:<host>:<container>` (the orchestrator's loopback form).
    const parts = spec.split(":");
    if (parts.length === 3) {
      const hostPort = Number(parts[1]);
      const containerPort = Number(parts[2]);
      if (Number.isInteger(hostPort) && Number.isInteger(containerPort)) {
        return { hostPort, containerPort };
      }
    }
  }
  return null;
}
