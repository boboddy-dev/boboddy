/**
 * Integration test for the `work` command.
 *
 * Exercises (almost) the full real path a user gets when running
 * `boboddy work`: the production processProjectWork polling loop, claim
 * handling, runtime environment launch (devcontainer + AI container), the real
 * OpenCode agent runner, findings submission via the
 * boboddy-submit-step-findings tool, and step completion.
 *
 * What is faked:
 *   - The platform server: a programmable in-memory StepExecutionWorkerClient
 *     (configures which jobs to claim + the worker context).
 *   - The AI provider: a host-side fake Anthropic server. OpenCode (inside the
 *     AI container) is pointed at it via a seeded opencode config.
 *   - git clone: a fake clone service copies a bundled dummy repo into the
 *     workspace (no network).
 *
 * Real containers are launched via testcontainers so they are reliably reaped
 * (Ryuk) and explicitly torn down after each test.
 *
 * Gated behind BOBODDY_INTEGRATION=true because it pulls real images and starts
 * Docker containers. The AI worker image must be present locally
 * (`docker pull <resolveAiImage().ref>`).
 *
 * Run with:
 *   BOBODDY_INTEGRATION=true bun test tests/work/step-execution/integration
 *
 * Env flags:
 *   BOBODDY_INTEGRATION=true            enable this suite (otherwise skipped)
 *   BOBODDY_INTEGRATION_VERBOSE=true    print worker logs during the run
 *   BOBODDY_INTEGRATION_KEEP_CONTAINERS=true
 *       leave the spun-up devcontainer + AI container (and their network and
 *       workspace) running after the test instead of tearing them down, so you
 *       can inspect them with `docker ps` / `docker logs`. Remove them later:
 *         docker rm -f $(docker ps -aq --filter label=boboddy.runtime-role)
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { runProjectWork } from "../../../../src/work/step-execution/application/run-project-work";
import { FakeAiServer } from "./helpers/fake-ai-server";
import { FakeStepExecutionWorkerClient } from "./helpers/fake-worker-client";
import { buildIntegrationDeps } from "./helpers/build-integration-deps";
import { buildSingleStepScenario } from "./helpers/scenario";
import type { ContainerRegistry } from "./helpers/containers/container-registry";

const integrationEnabled = process.env["BOBODDY_INTEGRATION"] === "true";
// When set, the spun-up containers (and their network/workspace) are preserved
// after the run for manual inspection: the orchestrator skips post-completion
// cleanup (preserveRuntimeOnComplete) and the test skips ContainerRegistry
// teardown. With the Ryuk reaper disabled by default, nothing reaps them.
const keepContainers =
  process.env["BOBODDY_INTEGRATION_KEEP_CONTAINERS"] === "true";
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

function resolveFakeAiHost(): string {
  const configured = process.env["BOBODDY_FAKE_AI_HOST"]?.trim();
  if (configured) return configured;
  // macOS/Windows Docker Desktop resolves this natively; on Linux the AI
  // launcher adds --add-host host.docker.internal:host-gateway.
  return "host.docker.internal";
}

async function seedOpencodeConfig(
  configHomeDir: string,
  fakeAiPort: number,
): Promise<void> {
  const configDir = path.join(configHomeDir, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  const config = {
    model: "anthropic/claude-3-5-haiku-latest",
    provider: {
      anthropic: {
        options: {
          baseURL: `http://${resolveFakeAiHost()}:${String(fakeAiPort)}`,
          apiKey: "fake-key",
        },
      },
    },
  };
  await writeFile(
    path.join(configDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

describe.skipIf(!integrationEnabled)("work command (integration)", () => {
  let fakeAi: FakeAiServer;
  let homeDir: string;
  let originalHome: string | undefined;
  let containerRegistry: ContainerRegistry | undefined;

  beforeEach(async () => {
    // We do explicit, deterministic container cleanup via the ContainerRegistry,
    // so the Ryuk reaper is optional. Disabling it by default avoids hangs on
    // Docker setups where the reaper container fails to become ready. Override
    // by setting TESTCONTAINERS_RYUK_DISABLED=false to re-enable it.
    if (process.env["TESTCONTAINERS_RYUK_DISABLED"] === undefined) {
      process.env["TESTCONTAINERS_RYUK_DISABLED"] = "true";
    }

    fakeAi = new FakeAiServer();
    homeDir = await mkdtemp(path.join(os.tmpdir(), "boboddy-work-it-home-"));
    // The AI launcher reads the opencode config from os.homedir()/.config so
    // OpenCode in the container picks up the fake AI provider baseURL.
    originalHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
  });

  afterEach(async () => {
    if (keepContainers) {
      // Intentionally leave the spun-up containers, network, and workspace in
      // place for inspection. List them with:
      //   docker ps --filter label=boboddy.runtime-role
      // and remove them when done with:
      //   docker rm -f $(docker ps -aq --filter label=boboddy.runtime-role)
      containerRegistry = undefined;
      await fakeAi.stop().catch(() => undefined);
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      return;
    }

    await containerRegistry?.stopAll();
    containerRegistry = undefined;
    await fakeAi.stop().catch(() => undefined);
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test(
    "happy path: claims a job, runs the agent, and completes with submitted findings",
    async () => {
      const projectId = createUuidV7();
      const findings = { confidence: 1, summary: "integration ok" };

      const scenario = buildSingleStepScenario({
        projectId,
        stepExecutionId: createUuidV7(),
        stepDefinitionId: createUuidV7(),
        prompt: "Submit the integration findings.",
        findings,
      });

      const fakeAiPort = await fakeAi.start();
      fakeAi.configure(findings);
      await seedOpencodeConfig(homeDir, fakeAiPort);

      const workerClient = new FakeStepExecutionWorkerClient(scenario);
      const built = buildIntegrationDeps({
        workerClient,
        verbose: process.env["BOBODDY_INTEGRATION_VERBOSE"] === "true",
      });
      containerRegistry = built.containerRegistry;

      const result = await runProjectWork(
        {
          projectId,
          baseUrl: "http://127.0.0.1:1",
          concurrency: 1,
          batchSize: 1,
          // Generous interval: the agent submits findings to a workspace bind
          // mount, and the monitor's "stopped without findings" retry windows
          // are pollIntervalMs apart. A larger interval absorbs bind-mount
          // propagation latency (notably on macOS Docker Desktop) so the host
          // sees the findings file before the monitor gives up.
          pollIntervalMs: 5_000,
          leaseDurationSeconds: 60,
          once: true,
          // When keeping containers, skip the orchestrator's post-completion
          // cleanup so the devcontainer + AI container survive the run.
          preserveRuntimeOnComplete: keepContainers,
        },
        built.deps,
      );

      expect(result.claimedCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(result.skippedCount).toBe(0);

      // The agent's findings were submitted to the (fake) server exactly once.
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(workerClient.failCalls).toHaveLength(0);

      const [completion] = workerClient.completeCalls;
      expect(completion?.stepExecutionId).toBe(
        scenario.steps[0]!.stepExecutionId,
      );
      expect(completion?.errorJson).toBeNull();
      expect(completion?.resultJson).toEqual(findings);

      // The fake AI was actually exercised (at least the initial tool_use turn
      // plus the end_turn follow-up).
      expect(fakeAi.requestCount).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT_MS,
  );
});
