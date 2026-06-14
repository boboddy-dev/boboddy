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

type MinimalDevcontainerConfig = {
  image?: string;
};

/**
 * testcontainers-backed DevcontainerLauncher for integration tests.
 *
 * Rather than driving the @devcontainers/cli (which requires the bundled CLI
 * script and is slow), it launches the image declared in the dummy repo's
 * devcontainer.json as a long-running container with the workspace
 * bind-mounted at /workspace, mirroring the essential behaviour the rest of
 * the runtime flow depends on. Containers are tracked for reaping.
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
    const image = await this.resolveImage(
      path.join(input.workspacePath, input.devcontainerConfigPath),
    );

    const container = new GenericContainer(image)
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      // Keep the container alive (base devcontainer images otherwise exit) and
      // emit a marker line so we can wait on it. The base image exposes no
      // ports, so a port-based wait strategy would never resolve.
      .withEntrypoint([])
      .withCommand(["sh", "-c", `echo ${READY_MARKER} && exec sleep infinity`])
      .withBindMounts([
        { source: input.workspacePath, target: "/workspace", mode: "rw" },
      ])
      .withWorkingDir("/workspace")
      .withWaitStrategy(
        Wait.forLogMessage(READY_MARKER).withStartupTimeout(STARTUP_TIMEOUT_MS),
      )
      .withLabels({
        "boboddy.runtime-role": "project",
        "boboddy.project-runtime-session-id": input.sessionId,
      });

    const started = await container.start();
    this.registry.register(started);

    return {
      containerId: started.getId(),
      metadata: { image },
    };
  }

  async stop(containerId: string): Promise<void> {
    await this.registry.stop(containerId);
  }

  private async resolveImage(configPath: string): Promise<string> {
    try {
      const raw = await readFile(configPath, "utf8");
      // devcontainer.json permits // comments; strip them for JSON.parse.
      const stripped = raw.replace(/\/\/[^\n]*/g, "");
      const parsed = JSON.parse(stripped) as MinimalDevcontainerConfig;
      return parsed.image?.trim() || DEFAULT_IMAGE;
    } catch {
      return DEFAULT_IMAGE;
    }
  }
}
