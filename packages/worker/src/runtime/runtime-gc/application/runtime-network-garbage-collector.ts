import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Legacy prefix for per-session Docker networks created by the former
 * dual-container orchestration. The single-container runtime no longer creates
 * these, but the GC still reaps any leftovers from older runs.
 */
export const RUNTIME_SESSION_NETWORK_NAME_PREFIX =
  "boboddy-project-runtime-session";

type DockerNetworkInspect = {
  Name?: string | undefined;
  Containers?: Record<string, unknown> | null | undefined;
};

export type RuntimeNetworkCleanupResult = {
  scannedCount: number;
  removedCount: number;
  keptCount: number;
  removedNetworks: string[];
  keptNetworks: string[];
};

export class RuntimeNetworkGarbageCollector {
  constructor(
    private readonly deps: {
      execFileAsync(
        file: string,
        args: string[],
      ): Promise<{ stdout: string; stderr: string }>;
    } = { execFileAsync },
  ) {}

  async cleanupUnusedNetworks(): Promise<RuntimeNetworkCleanupResult> {
    const networkNames = await this.listCandidateNetworkNames();
    const removedNetworks: string[] = [];
    const keptNetworks: string[] = [];

    for (const networkName of networkNames) {
      const network = await this.inspectNetwork(networkName);
      const endpointCount = Object.keys(network.Containers ?? {}).length;

      if (endpointCount > 0) {
        keptNetworks.push(networkName);
        continue;
      }

      await this.deps.execFileAsync("docker", ["network", "rm", networkName]);
      removedNetworks.push(networkName);
    }

    return {
      scannedCount: networkNames.length,
      removedCount: removedNetworks.length,
      keptCount: keptNetworks.length,
      removedNetworks,
      keptNetworks,
    };
  }

  private async listCandidateNetworkNames(): Promise<string[]> {
    const { stdout } = await this.deps.execFileAsync("docker", [
      "network",
      "ls",
      "--format",
      "{{.Name}}",
    ]);

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(RUNTIME_SESSION_NETWORK_NAME_PREFIX));
  }

  private async inspectNetwork(networkName: string): Promise<DockerNetworkInspect> {
    const { stdout } = await this.deps.execFileAsync("docker", [
      "network",
      "inspect",
      networkName,
    ]);
    const [network] = JSON.parse(stdout) as DockerNetworkInspect[];

    if (!network) {
      throw new Error(`Expected docker network ${networkName} to exist`);
    }

    return network;
  }
}
