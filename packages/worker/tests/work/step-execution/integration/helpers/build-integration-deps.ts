import { createLogger } from "../../../../../src/lib/logger";
import { systemTimeProvider } from "../../../../../src/lib/time-provider";
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
import { FakeGitCloneService } from "./fake-git-clone-service";
import type { FakeStepExecutionWorkerClient } from "./fake-worker-client";
import { ContainerRegistry } from "./containers/container-registry";
import { TestcontainersAiContainerLauncher } from "./containers/testcontainers-ai-container-launcher";
import { TestcontainersDevcontainerLauncher } from "./containers/testcontainers-devcontainer-launcher";

export type IntegrationDeps = {
  deps: ProcessProjectWorkDeps;
  containerRegistry: ContainerRegistry;
};

/**
 * Composes a ProcessProjectWorkDeps for integration tests:
 *
 *   - workerClient: injected fake (no platform server required)
 *   - gitCloneService: fake (materializes a dummy repo, no network)
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
}): IntegrationDeps {
  const logger = createLogger({
    name: "@boboddy/worker-integration",
    level: input.verbose ? "debug" : "silent",
  });

  const containerRegistry = new ContainerRegistry();

  const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
    logger.child({ scope: "runtime-environment-orchestrator" }),
    {
      workspaceManager: new LocalWorkspaceManager(),
      gitCloneService: new FakeGitCloneService(),
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
