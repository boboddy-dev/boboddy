/**
 * Integration test for the `work` command (SINGLE-CONTAINER model).
 *
 * Exercises (almost) the full real path a user gets when running
 * `boboddy work`: the production processProjectWork polling loop, claim
 * handling, single-container runtime launch (the user's devcontainer, with the
 * Boboddy OpenCode runtime payload mounted and OpenCode started INSIDE it — no
 * separate AI container, network, or cross-container bridge), the real OpenCode
 * agent runner, findings submission via the boboddy-submit-step-findings tool,
 * and step completion.
 *
 * What is faked:
 *   - The platform server: a programmable in-memory StepExecutionWorkerClient
 *     (configures which jobs to claim + the worker context).
 *   - The AI provider: a host-side fake Anthropic server. The in-container
 *     OpenCode is pointed at it via a seeded opencode config (the in-container
 *     agent reaches the host over host.docker.internal).
 *   - git clone: a fake clone service copies a bundled dummy repo into the
 *     workspace (no network).
 *
 * The single devcontainer is launched via testcontainers (honoring the
 * orchestrator's injected payload/agent-HOME mounts and appPort publish) so it
 * is reliably reaped (Ryuk) and explicitly torn down after each test.
 *
 * Gated behind BOBODDY_INTEGRATION=true because it provisions the real OpenCode
 * runtime payload (downloaded from the npm registry by the
 * OpencodeRuntimePayloadProvisioner) and starts a Docker container. No AI worker
 * image is pulled — there is no AI container in the single-container model.
 *
 * Run with:
 *   BOBODDY_INTEGRATION=true bun test tests/work/step-execution/integration
 *
 * Env flags:
 *   BOBODDY_INTEGRATION=true            enable this suite (otherwise skipped)
 *   BOBODDY_INTEGRATION_VERBOSE=true    print worker logs during the run
 *   BOBODDY_INTEGRATION_KEEP_CONTAINERS=true
 *       leave the spun-up devcontainer (and its workspace) running after the
 *       test instead of tearing it down, so you can inspect it with
 *       `docker ps` / `docker logs`. Remove it later:
 *         docker rm -f $(docker ps -aq --filter label=boboddy.runtime-role)
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { runProjectWork } from "../../../../src/work/step-execution/application/run-project-work";
import {
  FakeAiServer,
  seedOpencodeConfig,
} from "../../../../src/work/step-execution/infra/fake-ai";
import { FakeStepExecutionWorkerClient } from "./helpers/fake-worker-client";
import { buildIntegrationDeps } from "./helpers/build-integration-deps";
import { buildSingleStepScenario } from "./helpers/scenario";
import type { ContainerRegistry } from "./helpers/containers/container-registry";

const integrationEnabled = process.env["BOBODDY_INTEGRATION"] === "true";
  // When set, the spun-up devcontainer (and its workspace) is preserved after
  // the run for manual inspection: the orchestrator skips post-completion
  // cleanup (preserveRuntimeOnComplete) and the test skips ContainerRegistry
  // teardown. With the Ryuk reaper disabled by default, nothing reaps it.
const keepContainers =
  process.env["BOBODDY_INTEGRATION_KEEP_CONTAINERS"] === "true";
// Bounded so a regression (e.g. the agent cannot reach the fake AI host) fails
// in minutes, not the old 5-min-per-test hang. Real setup (runtime payload
// provision + container start) completes in ~15s and the happy path finishes in
// seconds once connectivity works; the monitor's own sessionStartTimeoutMs
// (below) is the primary fail-fast guard.
const TEST_TIMEOUT_MS = 3 * 60 * 1000;

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
    // The provider-access resolver discovers the local OpenCode config under
    // os.homedir()/.config so the in-container OpenCode picks up the fake AI
    // provider baseURL via the materialized + mounted provider config.
    originalHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
  });

  afterEach(async () => {
    if (keepContainers) {
      // Intentionally leave the spun-up devcontainer and workspace in place for
      // inspection. List it with:
      //   docker ps --filter label=boboddy.runtime-role
      // and remove it when done with:
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
      fakeAi.configure("boboddy-submit-step-findings", {
        findingsJson: findings,
      });
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
          // Generous interval: the in-container agent submits findings to the
          // shared workspace bind mount, and the monitor's "stopped without
          // findings" retry windows are pollIntervalMs apart. A larger interval
          // gives the agent room to finish before the monitor gives up. (In the
          // single-container model the workspace is the same bind mount the
          // agent and worker both see, so there is no cross-container
          // propagation step.)
          pollIntervalMs: 5_000,
          leaseDurationSeconds: 60,
          once: true,
          // Fail fast if the agent session never starts (e.g. the in-container
          // agent cannot reach the host fake AI server) instead of polling
          // until TEST_TIMEOUT_MS.
          sessionStartTimeoutMs: 60_000,
          // When keeping the runtime, skip the orchestrator's post-completion
          // cleanup so the single devcontainer survives the run.
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
        scenario.steps[0]?.stepExecutionId,
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
