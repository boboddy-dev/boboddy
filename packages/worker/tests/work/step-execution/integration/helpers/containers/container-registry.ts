import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StartedTestContainer } from "testcontainers";

const execFileAsync = promisify(execFile);

/**
 * Tracks every container started during a test so they can be torn down
 * deterministically. testcontainers' Ryuk reaper is the ultimate safety net,
 * but explicit teardown keeps the local Docker state clean between runs.
 *
 * Two flavours of container are tracked:
 *   - testcontainers-managed StartedTestContainers (the devcontainer), and
 *   - raw container IDs created directly via `docker` (e.g. a standalone
 *     OpenCode container).
 */
export class ContainerRegistry {
  private readonly started = new Map<string, StartedTestContainer>();
  private readonly rawContainerIds = new Set<string>();

  register(container: StartedTestContainer): void {
    this.started.set(container.getId(), container);
  }

  /** Track a container created directly via `docker` (e.g. the AI container). */
  registerContainerId(containerId: string): void {
    this.rawContainerIds.add(containerId);
  }

  get(containerId: string): StartedTestContainer | undefined {
    return this.started.get(containerId);
  }

  async stop(containerId: string): Promise<void> {
    if (this.rawContainerIds.has(containerId)) {
      this.rawContainerIds.delete(containerId);
      await this.removeRawContainer(containerId);
      return;
    }

    const container = this.started.get(containerId);
    if (!container) {
      return;
    }
    this.started.delete(containerId);
    await container.stop({ remove: true }).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    const containers = [...this.started.values()];
    this.started.clear();
    const rawIds = [...this.rawContainerIds];
    this.rawContainerIds.clear();
    await Promise.allSettled([
      ...containers.map((container) =>
        container.stop({ remove: true }).catch(() => undefined),
      ),
      ...rawIds.map((id) => this.removeRawContainer(id)),
    ]);
  }

  private async removeRawContainer(containerId: string): Promise<void> {
    await execFileAsync("docker", ["rm", "-f", containerId]).catch(
      () => undefined,
    );
  }
}
