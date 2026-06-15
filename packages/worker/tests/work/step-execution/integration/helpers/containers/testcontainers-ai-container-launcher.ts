import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AiContainerLauncher,
  LaunchAiContainerInput,
  LaunchAiContainerResult,
} from "../../../../../../src/runtime/runtime-service/application/ai-container-launcher";
import {
  DockerAiContainerLauncher,
  resolveAiImage,
} from "../../../../../../src/runtime/runtime-service/infra/docker-ai-container-launcher";
import type { ContainerRegistry } from "./container-registry";

const execFileAsync = promisify(execFile);

/**
 * AiContainerLauncher used only in integration tests.
 *
 * Earlier this used testcontainers' GenericContainer with auto-published ports
 * (withExposedPorts). That diverged from production in a way that broke CI: the
 * AI container's host port was reachable by testcontainers' own health probe
 * but NOT by the worker's HTTP client, producing an immediate ConnectionRefused
 * on http://<host>:<port>/session (neither 127.0.0.1 nor getHost() worked).
 *
 * Rather than keep chasing testcontainers' port-publishing/host-resolution
 * behaviour, this now delegates to the *production* DockerAiContainerLauncher,
 * which is the exact code path that already works on the same CI (it publishes
 * the port with `docker create -p 127.0.0.1:<freePort>:4096`, attaches networks
 * before start, and gates readiness on the /global/health probe). We only add
 * deterministic teardown by tracking the created container id in the registry.
 *
 * The production launcher resolves the host opencode config from HOME (honoring
 * a HOME override), so the test's seeded fake-AI provider config is still
 * picked up. The image-presence check lives in the production launcher's flow;
 * we additionally assert it up front to give a clearer error if the image was
 * not pulled.
 */
export class TestcontainersAiContainerLauncher implements AiContainerLauncher {
  private readonly inner = new DockerAiContainerLauncher();

  constructor(private readonly registry: ContainerRegistry) {}

  async launch(input: LaunchAiContainerInput): Promise<LaunchAiContainerResult> {
    await assertImagePresent(resolveAiImage().ref);

    const result = await this.inner.launch(input);
    // Track for deterministic teardown. The production launcher creates the
    // container directly via `docker`, so register it as a raw container id.
    this.registry.registerContainerId(result.containerId);
    return result;
  }

  async stop(containerId: string): Promise<void> {
    await this.registry.stop(containerId);
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
