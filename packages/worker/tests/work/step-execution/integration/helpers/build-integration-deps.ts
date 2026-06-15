import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../../../../src/lib/logger";
import { systemTimeProvider } from "../../../../../src/lib/time-provider";
import type { ArtifactStore } from "../../../../../src/artifacts/artifact-store/domain/artifact-store";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../../src/work/step-execution/infra/local-project-runtime-environment";
import { DefaultOpencodeStepRunner } from "../../../../../src/work/step-execution/infra/opencode-step-runner";
import { SqliteLocalRuntimeSessionStore } from "../../../../../src/work/step-execution/infra/sqlite-local-runtime-session-store";
import { LocalWorkspaceManager } from "../../../../../src/runtime/runtime-service/infra/local-workspace-manager";
import { LocalDockerRuntimeSessionNetworkManager } from "../../../../../src/runtime/runtime-service/infra/local-docker-runtime-session-network-manager";
import { LocalDevcontainerPortForwardManager } from "../../../../../src/runtime/runtime-service/infra/local-devcontainer-port-forward-manager";
import { LocalDevcontainerMcpHostManager } from "../../../../../src/runtime/runtime-service/infra/local-devcontainer-mcp-host-manager";
import { LocalRuntimeCommandRunner } from "../../../../../src/runtime/runtime-service/infra/local-runtime-command-runner";
import { LocalRuntimeServiceRunner } from "../../../../../src/runtime/runtime-service/infra/local-runtime-service-runner";
import type { ProcessProjectWorkDeps } from "../../../../../src/work/step-execution/application/run-project-work";
import {
  FakeGitCloneService,
  type CloneRepositoryInput,
  type CloneRepositoryResult,
} from "./fake-git-clone-service";
import type { FakeStepExecutionWorkerClient } from "./fake-worker-client";
import { ContainerRegistry } from "./containers/container-registry";
import { TestcontainersAiContainerLauncher } from "./containers/testcontainers-ai-container-launcher";
import { TestcontainersDevcontainerLauncher } from "./containers/testcontainers-devcontainer-launcher";

export type ArtifactSeed = {
  /** Relative path inside .boboddy/step-artifacts/ (e.g. "report.txt" or "logs/run.log"). */
  relativePath: string;
  content: string;
};

export type IntegrationDeps = {
  deps: ProcessProjectWorkDeps;
  containerRegistry: ContainerRegistry;
};

/**
 * A FakeGitCloneService wrapper that seeds artifact files into
 * <workspacePath>/.boboddy/step-artifacts/ immediately after the dummy repo is
 * copied. This guarantees the files are present on the host bind-mount before
 * the agent session stops and collectStepArtifacts runs.
 *
 * Note: startProcessClaimedExecution creates the step-artifacts dir via
 * `mkdir(..., { recursive: true })` which will not clobber pre-existing files.
 */
class SeedingGitCloneService {
  private readonly inner: FakeGitCloneService;

  constructor(private readonly seeds: ArtifactSeed[]) {
    this.inner = new FakeGitCloneService();
  }

  async cloneRepository(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    const result = await this.inner.cloneRepository(input);

    if (this.seeds.length > 0) {
      const artifactsDir = path.join(
        input.workspacePath,
        ".boboddy",
        "step-artifacts",
      );
      for (const seed of this.seeds) {
        const dest = path.join(artifactsDir, seed.relativePath);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, seed.content, "utf8");
      }
    }

    return result;
  }
}

/**
 * Composes a ProcessProjectWorkDeps for integration tests:
 *
 *   - workerClient: injected fake (no platform server required)
 *   - gitCloneService: fake (materializes a dummy repo, no network). When
 *     seedArtifacts are provided, a seeding wrapper writes those files into
 *     <workspacePath>/.boboddy/step-artifacts/ after the clone so they are
 *     present for collectStepArtifacts when the agent session stops.
 *   - artifactStore: optional override; defaults to the production
 *     LocalArtifactStore under ~/.boboddy/artifacts when omitted.
 *   - devcontainer + AI container launchers: testcontainers-backed. They
 *     produce real Docker containers tracked in the ContainerRegistry for
 *     teardown. To make containers persist after a run, the test skips
 *     registry teardown and sets preserveRuntimeOnComplete (see the
 *     BOBODDY_INTEGRATION_KEEP_CONTAINERS flag).
 *   - everything else (run tracker, agent runner, network manager, port
 *     forward, mcp host, runtime command/service runners, time, sleep,
 *     logger): the real production implementations.
 *
 * The AI agent is mocked at the HTTP layer via the FakeAiServer + a seeded
 * opencode config (see the test), not here.
 */
export function buildIntegrationDeps(input: {
  workerClient: FakeStepExecutionWorkerClient;
  /** Set true to see worker logs during a test run. */
  verbose?: boolean;
  /**
   * Artifact files to seed into <workspacePath>/.boboddy/step-artifacts/ after
   * the dummy repo is cloned. Each entry specifies a relative path and content.
   * Used to exercise the artifact collection + persistence path without needing
   * the agent to write files itself.
   */
  seedArtifacts?: ArtifactSeed[] | undefined;
  /**
   * Override the artifact store. When provided, this store is used instead of
   * the default LocalArtifactStore under ~/.boboddy/artifacts. Tests pass a
   * LocalArtifactStore pointed at a temp dir so they can assert the persisted
   * files without touching the real user-facing artifact directory.
   */
  artifactStore?: ArtifactStore | undefined;
}): IntegrationDeps {
  const logger = createLogger({
    name: "@boboddy/worker-integration",
    level: input.verbose ? "debug" : "silent",
  });

  const containerRegistry = new ContainerRegistry();

  const gitCloneService =
    input.seedArtifacts && input.seedArtifacts.length > 0
      ? new SeedingGitCloneService(input.seedArtifacts)
      : new FakeGitCloneService();

  const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
    logger.child({ scope: "runtime-environment-orchestrator" }),
    {
      workspaceManager: new LocalWorkspaceManager(),
      gitCloneService,
      devcontainerLauncher: new TestcontainersDevcontainerLauncher(
        containerRegistry,
      ),
      aiContainerLauncher: new TestcontainersAiContainerLauncher(
        containerRegistry,
      ),
      runtimeSessionNetworkManager:
        new LocalDockerRuntimeSessionNetworkManager(),
      portForwardManager: new LocalDevcontainerPortForwardManager(),
      mcpHostManager: new LocalDevcontainerMcpHostManager(),
    },
  );

  const deps: ProcessProjectWorkDeps = {
    createWorkerClient: () => Promise.resolve(input.workerClient),
    createRunTracker: () => new SqliteLocalRuntimeSessionStore(),
    runtimeEnvironmentOrchestrator: orchestrator,
    agentRunner: new DefaultOpencodeStepRunner(),
    artifactStore: input.artifactStore,
    runtimeCommandRunner: new LocalRuntimeCommandRunner(
      logger.child({ scope: "runtime-command-runner" }),
    ),
    runtimeServiceRunner: new LocalRuntimeServiceRunner(
      new LocalDevcontainerPortForwardManager(),
      logger.child({ scope: "runtime-service-runner" }),
    ),
    timeProvider: systemTimeProvider,
    sleep: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    logger: {
      log: (scope, message, details) => {
        logger.info({ ...details, workScope: scope }, message);
      },
      error: (scope, message, details) => {
        logger.error({ ...details, workScope: scope }, message);
      },
    },
  };

  return { deps, containerRegistry };
}
