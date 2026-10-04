/**
 * Integration tests for the runtime a step selects (`environment.runtime`),
 * through the real `work` loop and a real Docker devcontainer (see
 * `work-command.integration.test.ts` for the setup and the env flags).
 *
 *   - A `workspace` step that selects `.devcontainer/alt/devcontainer.json`
 *     launches that config, and the config the worker patched stays out of the
 *     work-branch commit.
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
 * Gated behind BOBODDY_INTEGRATION=true.
 *
 *   BOBODDY_INTEGRATION=true bun test tests/work/step-execution/integration/work-command-runtime
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
import {
  buildIntegrationDeps,
  type IntegrationDeps,
} from "./helpers/build-integration-deps";
import { buildSingleStepScenario, type WorkScenario } from "./helpers/scenario";

const integrationEnabled = process.env["BOBODDY_INTEGRATION"] === "true";
const TEST_TIMEOUT_MS = 3 * 60 * 1000;
const ALT_CONFIG_PATH = ".devcontainer/alt/devcontainer.json";
const CODE_STEP_ENTRYPOINT = {
  sourceFile: ".boboddy/pipeline-builder/integration-code-step.mjs",
};
const INSPECTING_CODE_STEP_ENTRYPOINT = {
  sourceFile: ".boboddy/pipeline-builder/integration-inspecting-code-step.mjs",
};
const WRITING_CODE_STEP_ENTRYPOINT = {
  sourceFile: ".boboddy/pipeline-builder/integration-writing-code-step.mjs",
};
const RUNTIME_PROBE_CODE_STEP_ENTRYPOINT = {
  sourceFile:
    ".boboddy/pipeline-builder/integration-runtime-probe-code-step.mjs",
};
const BUN1_MANAGED_CONFIG_PATH =
  ".boboddy/managed-devcontainers/bun1/devcontainer.json";
const NODE24_MANAGED_CONFIG_PATH =
  ".boboddy/managed-devcontainers/node24/devcontainer.json";

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
    await built?.containerRegistry.stopAll();
    built = undefined;
    await fakeAi.stop().catch(() => undefined);
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function runScenario(
    scenario: WorkScenario,
    findings: Record<string, unknown>,
    options: { rejectRemotePushes?: boolean } = {},
  ): Promise<{
    workerClient: FakeStepExecutionWorkerClient;
    integration: IntegrationDeps;
  }> {
    const fakeAiPort = await fakeAi.start();
    fakeAi.configure("boboddy-submit-step-findings", {
      findingsJson: findings,
    });
    await seedOpencodeConfig(homeDir, fakeAiPort);

    const workerClient = new FakeStepExecutionWorkerClient(scenario);
    const integration = buildIntegrationDeps({
      workerClient,
      verbose: process.env["BOBODDY_INTEGRATION_VERBOSE"] === "true",
      rejectRemotePushes: options.rejectRemotePushes,
    });
    built = integration;

    await runProjectWork(
      {
        projectId: scenario.projectId,
        baseUrl: "http://127.0.0.1:1",
        concurrency: 1,
        batchSize: 1,
        pollIntervalMs: 5_000,
        leaseDurationSeconds: 60,
        once: true,
        sessionStartTimeoutMs: 60_000,
        preserveRuntimeOnComplete: false,
      },
      integration.deps,
    );
    return { workerClient, integration };
  }

  function scenarioFor(
    overrides: Partial<Parameters<typeof buildSingleStepScenario>[0]>,
    findings: Record<string, unknown>,
  ) {
    return buildSingleStepScenario({
      projectId: createUuidV7(),
      stepExecutionId: createUuidV7(),
      stepDefinitionId: createUuidV7(),
      findings,
      ...overrides,
    });
  }

  test(
    "a workspace step launches its selected devcontainer config and keeps the patched file out of the commit",
    async () => {
      const findings = { confidence: 1, summary: "alt config ok" };
      const { workerClient, integration } = await runScenario(
        scenarioFor({ devcontainerConfigPath: ALT_CONFIG_PATH }, findings),
        findings,
      );

      expect(workerClient.failCalls).toHaveLength(0);
      expect(workerClient.completeCalls).toHaveLength(1);
      expect(workerClient.completeCalls[0]?.resultJson).toEqual(findings);
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
    ["bun1", BUN1_MANAGED_CONFIG_PATH, true],
    ["node24", NODE24_MANAGED_CONFIG_PATH, false],
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
    "a readOnly step completes and leaves no new branch on the remote",
    async () => {
      const findings = { confidence: 1, summary: "read only ok" };
      const { workerClient, integration } = await runScenario(
        scenarioFor({ repo: { mode: "readOnly" } }, findings),
        findings,
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
      const stepExecutionId = scenario.steps[0]?.stepExecutionId ?? "";
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
        `Failed to push work branch "boboddy/integration-step-${stepExecutionId}"`,
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
