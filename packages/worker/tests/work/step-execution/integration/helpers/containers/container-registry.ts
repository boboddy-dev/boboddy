import type { StartedTestContainer } from "testcontainers";

/**
 * Tracks every testcontainers container started during a test so they can be
 * torn down deterministically. testcontainers' Ryuk reaper is the ultimate
 * safety net, but explicit teardown keeps the local Docker state clean between
 * runs.
 */
export class ContainerRegistry {
  private readonly started = new Map<string, StartedTestContainer>();

  register(container: StartedTestContainer): void {
    this.started.set(container.getId(), container);
  }

  get(containerId: string): StartedTestContainer | undefined {
    return this.started.get(containerId);
  }

  async stop(containerId: string): Promise<void> {
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
    await Promise.allSettled(
      containers.map((container) =>
        container.stop({ remove: true }).catch(() => undefined),
      ),
    );
  }
}
