/**
 * Integration tests for the `work` command (SINGLE-CONTAINER model) and the
 * runtime a step selects (`environment.runtime`).
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
 *   - The platform server: a programmable in-memory TaskWorkerClient
 *     (configures which jobs to claim + the worker context).
 *   - The AI provider: a host-side fake Anthropic server. The in-container
 *     OpenCode is pointed at it via a seeded opencode config (the in-container
 *     agent reaches the host over host.docker.internal).
 *   - git clone: a fake clone service copies a bundled dummy repo into the
 *     workspace (no network).
 *
 * The single devcontainer is launched via testcontainers (honoring the
 * orchestrator's injected payload/agent-HOME mounts and appPort publish) so it
 * is explicitly torn down after each test.
 *
 * Scenarios:
 *
 *   - An agent `workspace` step that selects `.devcontainer/alt/devcontainer.json`
 *     claims the job, runs the agent against the fake AI, completes with the
 *     submitted findings, launches that config, and keeps the config the worker
 *     patched out of the work-branch commit.
 *   - A selected config that is missing from the clone fails the step before
 *     any container launches, naming the path and the branch.
 *   - A code step runs in the container its `Runtime.devcontainer({ config })`
 *     selects, and never starts OpenCode (no server process, no workspace
 *     plugin, no OpenCode mount or published port); the AI scenarios guard that
 *     the mount and port are still present when the server is needed.
 *   - A code step on a managed runtime launches the config the worker
 *     synthesizes for its identifier, runs on that image's runtime, never
 *     commits the managed config or install artifacts, and an identifier the
 *     worker does not know fails the step before any container launches. The
 *     launcher here honors `image` only: it does not run `onCreateCommand`, so
 *     the dependency install itself is covered by the unit tests, not here.
 *   - A step's `repo` decides what reaches the remote: `readOnly` pushes no
 *     branch, `readWrite` pushes a commit carrying the rendered message, and a
 *     remote that refuses the push fails the step (`"fail"`) or not (`"warn"`).
 *
 * Gated behind BOBODDY_INTEGRATION=true because it provisions the real OpenCode
 * runtime payload (downloaded from the npm registry by the
 * OpencodeRuntimePayloadProvisioner) and starts Docker containers.
 *
 * Run with:
 *   BOBODDY_INTEGRATION=true bun test tests/work/task/integration
 *
 * Env flags:
 *   BOBODDY_INTEGRATION=true            enable this suite (otherwise skipped)
 *   BOBODDY_INTEGRATION_VERBOSE=true    print worker logs during the run
 *   BOBODDY_INTEGRATION_KEEP_CONTAINERS=true
 *       leave the spun-up devcontainers (and their workspaces) running after
 *       each test instead of tearing them down, so you can inspect them with
 *       `docker ps` / `docker logs`. Remove them later:
 *         docker rm -f $(docker ps -aq --filter label=boboddy.runtime-role)
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { runProjectWork } from "../../../../src/work/task/application/run-project-work";
import {
  FakeAiServer,
  seedOpencodeConfig,
} from "../../../../src/work/task/infra/fake-ai";
import { FakeTaskWorkerClient } from "./helpers/fake-worker-client";
import {
  buildIntegrationDeps,
  type IntegrationDeps,
} from "./helpers/build-integration-deps";
import { buildSingleStepScenario, type WorkScenario } from "./helpers/scenario";

const integrationEnabled = process.env["BOBODDY_INTEGRATION"] === "true";
const keepContainers =
  process.env["BOBODDY_INTEGRATION_KEEP_CONTAINERS"] === "true";
const TEST_TIMEOUT_MS = 3 * 60 * 1000;
const ALT_CONFIG_PATH = ".devcontainer/alt/devcontainer.json";
function entrypoint(name: string) {
  return { sourceFile: `.boboddy/pipeline-builder/integration-${name}.mjs` };
}
const CODE_STEP_ENTRYPOINT = entrypoint("code-step");
const INSPECTING_CODE_STEP_ENTRYPOINT = entrypoint("inspecting-code-step");
const WRITING_CODE_STEP_ENTRYPOINT = entrypoint("writing-code-step");
const RUNTIME_PROBE_CODE_STEP_ENTRYPOINT = entrypoint(
  "runtime-probe-code-step",
);
const managedConfigPath = (id: string) =>
  `.boboddy/managed-devcontainers/${id}/devcontainer.json`;

describe.skipIf(!integrationEnabled)("step runtime (integration)", () => {
  let fakeAi: FakeAiServer;
  let homeDir: string;
  let originalHome: string | undefined;
  let built: IntegrationDeps | undefined;

  beforeEach(async () => {
    if (process.env["TESTCONTAINERS_RYUK_DISABLED"] === undefined) {
      process.env["TESTCONTAINERS_RYUK_DISABLED"] = "true";
    }
    fakeAi = new FakeAiServer();
    homeDir = await mkdtemp(path.join(os.tmpdir(), "boboddy-runtime-it-home-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
  });

  afterEach(async () => {
    await fakeAi.stop().catch(() => undefined);
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (!keepContainers) {
      await built?.containerRegistry.stopAll();
      await rm(homeDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    built = undefined;
  });

  async function runScenario(
    scenario: WorkScenario,
    findings: Record<string, unknown>,
    options: { rejectRemotePushes?: boolean } = {},
  ) {
    const fakeAiPort = await fakeAi.start();
    fakeAi.configure("boboddy-submit-step-findings", {
      findingsJson: findings,
    });
    await seedOpencodeConfig(homeDir, fakeAiPort);

    const workerClient = new FakeTaskWorkerClient(scenario);
    const integration = buildIntegrationDeps({
      workerClient,
      verbose: process.env["BOBODDY_INTEGRATION_VERBOSE"] === "true",
      rejectRemotePushes: options.rejectRemotePushes,
    });
    built = integration;

    const result = await runProjectWork(
      {
        projectId: scenario.projectId,
        baseUrl: "http://127.0.0.1:1",
        concurrency: 1,
        batchSize: 1,
        pollIntervalMs: 250,
        missingFindingsGraceMs: 5_000,
        leaseDurationSeconds: 60,
        once: true,
        sessionStartTimeoutMs: 60_000,
        preserveRuntimeOnComplete: keepContainers,
      },
      integration.deps,
    );
    return { workerClient, integration, result };
  }

  function scenarioFor(
    overrides: Partial<Parameters<typeof buildSingleStepScenario>[0]>,
    findings: Record<string, unknown>,
  ) {
    return buildSingleStepScenario({
      projectId: createUuidV7(),
      taskId: createUuidV7(),
      findings,
      ...overrides,
    });
  }

  test(
    "an agent step claims the job, completes with the submitted findings, launches its selected devcontainer config, and keeps the patched file out of the commit",
    async () => {
      const findings = { confidence: 1, summary: "alt config ok" };
      const scenario = scenarioFor(
        { devcontainerConfigPath: ALT_CONFIG_PATH },
        findings,
      );
      const { workerClient, integration, result } = await runScenario(
        scenario,
        findings,
      );

      expect(result.claimedCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      const [completion] = workerClient.completeCalls;
      expect(completion?.taskId).toBe(scenario.steps[0]?.taskId);
      expect(completion?.errorJson).toBeNull();
      expect(completion?.resultJson).toEqual(findings);
      expect(fakeAi.requestCount).toBeGreaterThanOrEqual(2);
      expect(integration.devcontainerLauncher.launchedConfigPaths).toEqual([
        ALT_CONFIG_PATH,
      ]);
      expect(
        integration.gitCommitPushService.committedFiles.flat(),
      ).not.toContain(ALT_CONFIG_PATH);
      const [launch] = integration.devcontainerLauncher.launches;
      expect(launch?.mounts.length).toBeGreaterThan(0);
      expect(launch?.publishedPort).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a selected config missing from the clone fails the step before any container launches",
    async () => {
      const missing = ".devcontainer/missing/devcontainer.json";
      const { workerClient, integration } = await runScenario(
        scenarioFor({ devcontainerConfigPath: missing }, {}),
        {},
      );

      expect(workerClient.completeCalls).toHaveLength(0);
      expect(workerClient.failCalls).toHaveLength(1);
      expect(workerClient.failCalls[0]?.errorJson).toMatchObject({
        message: `Devcontainer config "${missing}" not found in the cloned repository (branch "main")`,
      });
      expect(integration.devcontainerLauncher.launchedConfigPaths).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a code step runs in the container its selected devcontainer config launches",
    async () => {
      const { workerClient, integration } = await runScenario(
        scenarioFor(
          {
            devcontainerConfigPath: ALT_CONFIG_PATH,
            codeEntrypoint: CODE_STEP_ENTRYPOINT,
          },
          {},
        ),
        {},
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(workerClient.completeCalls[0]?.resultJson).toMatchObject({
        summary: "code step ok",
      });
      expect(integration.devcontainerLauncher.launchedConfigPaths).toEqual([
        ALT_CONFIG_PATH,
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a code step never starts OpenCode: no server process, no plugin in the workspace, no OpenCode mount or published port",
    async () => {
      const { workerClient, integration } = await runScenario(
        scenarioFor({ codeEntrypoint: INSPECTING_CODE_STEP_ENTRYPOINT }, {}),
        {},
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      const result = workerClient.completeCalls[0]?.resultJson as {
        opencodeProcesses: string[];
        processCount: number;
        opencodePluginPresent: boolean;
        opencodeDirectoryPresent: boolean;
      };
      expect(result.processCount).toBeGreaterThan(0);
      expect(result.opencodeProcesses).toEqual([]);
      expect(result.opencodePluginPresent).toBe(false);
      expect(result.opencodeDirectoryPresent).toBe(false);

      expect(integration.devcontainerLauncher.launches).toHaveLength(1);
      const [launch] = integration.devcontainerLauncher.launches;
      expect(launch?.mounts).toEqual([]);
      expect(launch?.publishedPort).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test.each([
    ["bun1", managedConfigPath("bun1"), true],
    ["node24", managedConfigPath("node24"), false],
  ] as const)(
    "a managed %s code step launches its synthesized config and runs on its own runtime, without OpenCode",
    async (managedRuntime, configPath, expectBun) => {
      const { workerClient, integration } = await runScenario(
        scenarioFor(
          {
            codeEntrypoint: RUNTIME_PROBE_CODE_STEP_ENTRYPOINT,
            managedRuntime,
          },
          {},
        ),
        {},
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(integration.devcontainerLauncher.launchedConfigPaths).toEqual([
        configPath,
      ]);
      const result = workerClient.completeCalls[0]?.resultJson as {
        bunVersion: string | null;
        nodeVersion: string;
        cwd: string;
      };
      expect(result.bunVersion !== null).toBe(expectBun);
      expect(result.cwd).toStartWith("/workspaces/");
      if (!expectBun) {
        expect(result.nodeVersion).toStartWith("24.");
      }
      const [launch] = integration.devcontainerLauncher.launches;
      expect(launch?.mounts).toEqual([]);
      expect(launch?.publishedPort).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a managed readWrite code step pushes its output and never the managed config or install artifacts",
    async () => {
      const { workerClient, integration } = await runScenario(
        scenarioFor(
          {
            codeEntrypoint: WRITING_CODE_STEP_ENTRYPOINT,
            managedRuntime: "bun1",
          },
          {},
        ),
        {},
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      const committed = integration.gitCommitPushService.committedFiles.flat();
      expect(committed).toContain("generated.txt");
      expect(
        committed.filter(
          (file) =>
            file.startsWith(".boboddy/managed-devcontainers") ||
            file.startsWith(".boboddy/pipeline-builder/node_modules"),
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an identifier this worker does not know fails the step before any container launches",
    async () => {
      const { workerClient, integration } = await runScenario(
        scenarioFor(
          {
            codeEntrypoint: RUNTIME_PROBE_CODE_STEP_ENTRYPOINT,
            managedRuntime: "bun9",
          },
          {},
        ),
        {},
      );

      expect(workerClient.completeCalls).toHaveLength(0);
      expect(workerClient.failCalls).toHaveLength(1);
      expect(workerClient.failCalls[0]?.errorJson).toMatchObject({
        message:
          'Managed runtime "bun9" is not supported by this worker. ' +
          "Supported managed runtimes: bun1, node24. " +
          "Upgrade the Boboddy CLI to a version that supports it.",
      });
      expect(integration.devcontainerLauncher.launchedConfigPaths).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a readOnly code step completes and leaves no new branch on the remote",
    async () => {
      const { workerClient, integration } = await runScenario(
        scenarioFor(
          {
            codeEntrypoint: WRITING_CODE_STEP_ENTRYPOINT,
            repo: { mode: "readOnly" },
          },
          {},
        ),
        {},
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(integration.gitCommitPushService.committedFiles).toEqual([]);
      expect(await integration.remote.branches()).toEqual(["main"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a readWrite step with a message template pushes a commit carrying the rendered message",
    async () => {
      const { workerClient, integration } = await runScenario(
        scenarioFor(
          {
            codeEntrypoint: WRITING_CODE_STEP_ENTRYPOINT,
            inputJson: { ticket: "ENG-42" },
            repo: {
              mode: "readWrite",
              message: "{{input.ticket}}: {{result.summary}}",
              onPushFailure: "fail",
            },
          },
          {},
        ),
        {},
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      const branches = (await integration.remote.branches()).filter(
        (branch) => branch !== "main",
      );
      expect(branches).toHaveLength(1);
      expect(workerClient.completeCalls[0]?.workBranch).toBe(branches[0]);
      expect(await integration.remote.commitSubject(branches[0] ?? "")).toBe(
        "ENG-42: wrote generated.txt",
      );
      expect(integration.gitCommitPushService.committedFiles.flat()).toContain(
        "generated.txt",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "onPushFailure fail: a remote that refuses the push fails the step with a message naming the branch",
    async () => {
      const scenario = scenarioFor(
        { codeEntrypoint: WRITING_CODE_STEP_ENTRYPOINT },
        {},
      );
      const taskId = scenario.steps[0]?.taskId ?? "";
      const { workerClient } = await runScenario(
        scenario,
        {},
        {
          rejectRemotePushes: true,
        },
      );

      expect(workerClient.completeCalls).toHaveLength(0);
      expect(workerClient.failCalls).toHaveLength(1);
      const message = (
        workerClient.failCalls[0]?.errorJson as { message: string }
      ).message;
      expect(message).toContain(
        `Failed to push work branch "boboddy/integration-step-${taskId}"`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "onPushFailure warn: a remote that refuses the push still completes the step, reporting no work branch",
    async () => {
      const { workerClient, integration } = await runScenario(
        scenarioFor(
          {
            codeEntrypoint: WRITING_CODE_STEP_ENTRYPOINT,
            repo: { mode: "readWrite", message: null, onPushFailure: "warn" },
          },
          {},
        ),
        {},
        { rejectRemotePushes: true },
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(workerClient.completeCalls[0]?.workBranch).toBeNull();
      expect(workerClient.completeCalls[0]?.createdFromBranch).toBe("main");
      expect(await integration.remote.branches()).toEqual(["main"]);
    },
    TEST_TIMEOUT_MS,
  );
});
