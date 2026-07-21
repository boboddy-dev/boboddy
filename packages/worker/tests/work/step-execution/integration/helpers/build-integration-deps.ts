import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../../../../src/lib/logger";
import type { ArtifactStore } from "../../../../../src/artifacts/artifact-store/domain/artifact-store";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../../src/work/step-execution/infra/local-project-runtime-environment";
import { DefaultOpencodeStepRunner } from "../../../../../src/work/step-execution/infra/opencode-step-runner";
import { SqliteLocalRuntimeSessionStore } from "../../../../../src/work/step-execution/infra/sqlite-local-runtime-session-store";
import { LocalWorkspaceManager } from "../../../../../src/runtime/runtime-service/infra/local-workspace-manager";
import { GitCliCommitPushService } from "../../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { GitCliSubmoduleService } from "../../../../../src/runtime/runtime-service/infra/git-cli-submodule-service";
import { OpencodeRuntimePayloadProvisioner } from "../../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { DevcontainerOpencodeBootstrap } from "../../../../../src/runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import { DirectProviderAccessResolver } from "../../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "../../../../../src/work/step-execution/infra/provider-access/session-runtime-config-materializer";
import os from "node:os";
import type { ProcessProjectWorkDeps } from "../../../../../src/work/step-execution/application/run-project-work";
import {
  FakeGitCloneService,
  type CloneRepositoryInput,
  type CloneRepositoryResult,
} from "./fake-git-clone-service";
import type { FakeStepExecutionWorkerClient } from "./fake-worker-client";
import { ContainerRegistry } from "./containers/container-registry";
import { TestcontainersDevcontainerLauncher } from "./containers/testcontainers-devcontainer-launcher";

/**
 * Make an Error under `details.error` visible in pino output. Pino's default
 * serializer only renders Error objects passed under the `err` key; an Error
 * under any other key (here, `error`) serializes to `{}`, which is exactly what
 * hid the real failure cause in CI. Replace it with a plain message string and
 * also attach an `err` field so pino's std serializer captures the stack.
 */
function normalizeErrorDetails(
  details?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!details || !("error" in details)) {
    return details;
  }
  const { error, ...rest } = details;
  if (error instanceof Error) {
    return { ...rest, error: error.message, err: error };
  }
  return { ...rest, error: String(error) };
}

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
 *   - devcontainer launcher: testcontainers-backed. It produces the single real
 *     Docker container (the devcontainer that also hosts OpenCode) tracked in
 *     the ContainerRegistry for teardown, honoring the orchestrator's injected
 *     payload/agent-HOME mounts + appPort publish. To make the container persist
 *     after a run, the test skips registry teardown and sets
 *     preserveRuntimeOnComplete (see the BOBODDY_INTEGRATION_KEEP_CONTAINERS
 *     flag).
 *   - single-container runtime deps: the real OpencodeRuntimePayloadProvisioner,
 *     DevcontainerOpencodeBootstrap, DirectProviderAccessResolver, and
 *     SessionRuntimeConfigMaterializer. OpenCode runs INSIDE the devcontainer;
 *     there is no separate AI container, session network, or cross-container
 *     bridge.
 *   - everything else (run tracker, agent runner, sleep, logger): the real
 *     production implementations. The agent runs commands and services itself
 *     via native bash inside the devcontainer, so there is no host-mediated
 *     runtime command/service runner.
 *
 * The AI provider is mocked at the HTTP layer via the FakeAiServer + a
 * discovered/materialized opencode config (see the test), not here.
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
  // Even when not running verbose, keep error-level logging on. The job and
  // monitor failure paths log through this injected logger; silencing it
  // entirely (the previous "silent" default) hid the real cause of failures in
  // CI and left only an unexplained processedCount 0. "error" surfaces those
  // failures without the noisy info-level run chatter.
  const logger = createLogger({
    name: "@boboddy/worker-integration",
    level: input.verbose ? "debug" : "error",
  });

  const containerRegistry = new ContainerRegistry();

  const gitCloneService =
    input.seedArtifacts && input.seedArtifacts.length > 0
      ? new SeedingGitCloneService(input.seedArtifacts)
      : new FakeGitCloneService();

  const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
    logger.child({ scope: "runtime-environment-orchestrator" }),
    {},
    {
      workspaceManager: new LocalWorkspaceManager(),
      gitCloneService,
      gitCommitPushService: new GitCliCommitPushService(logger),
      submoduleService: new GitCliSubmoduleService(logger),
      devcontainerLauncher: new TestcontainersDevcontainerLauncher(
        containerRegistry,
      ),
      payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
      opencodeBootstrap: new DevcontainerOpencodeBootstrap(),
      providerAccessResolver: new DirectProviderAccessResolver(),
      runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
        outputBaseDir: path.join(os.tmpdir(), "boboddy-provider-config"),
      }),
    },
  );

  const deps: ProcessProjectWorkDeps = {
    createWorkerClient: () => Promise.resolve(input.workerClient),
    createRunTracker: () => new SqliteLocalRuntimeSessionStore(),
    runtimeEnvironmentOrchestrator: orchestrator,
    agentRunner: new DefaultOpencodeStepRunner(),
    artifactStore: input.artifactStore,
    sleep: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    logger: {
      debug: (scope, message, details) => {
        logger.debug({ ...details, workScope: scope }, message);
      },
      log: (scope, message, details) => {
        logger.info({ ...details, workScope: scope }, message);
      },
      error: (scope, message, details) => {
        // The work code passes the underlying failure under `details.error`.
        // Pino only special-cases the `err` key for Error serialization, so a
        // raw Error under `error` renders as an empty object and hides the
        // cause. Normalize it to a readable message/stack (and mirror to `err`)
        // so CI logs actually show why a step failed.
        const normalized = normalizeErrorDetails(details);
        logger.error({ ...normalized, workScope: scope }, message);
      },
    },
  };

  return { deps, containerRegistry };
}
