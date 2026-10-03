/**
 * Coverage for the step-level `env` wiring in `startProcessClaimedExecution`
 * (`process-claimed-step-execution.ts`): the resolved variables reach the
 * runtime launch, secrets are registered with the log masker before anything
 * can echo them, a missing required variable fails before launch, and a step
 * that declares `env` gets a strict `{{env.X}}` prompt context.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { EnvVarSpec } from "@boboddy/sdk/env-vars";
import { startProcessClaimedExecution } from "../../../../src/work/step-execution/application/process-claimed-step-execution";
import type { ProcessProjectWorkDeps } from "../../../../src/work/step-execution/contracts/process-project-work-types";
import {
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  projectId,
  requestedByUserId,
  stepExecutionId,
} from "./helpers/claimed-step-execution-fixtures";

const ENV_JSON: EnvVarSpec[] = [
  {
    name: "ACCOUNT_ID",
    source: "value",
    value: "{{input.title}}-acct",
    secret: false,
  },
  {
    name: "TENANT_API_KEY",
    source: "value",
    value: "{{input.title}}-key",
    secret: true,
  },
  {
    name: "WAREHOUSE_TOKEN",
    source: "inherit",
    from: "WAREHOUSE_TOKEN",
    secret: true,
    optional: false,
  },
  {
    name: "LOG_LEVEL",
    source: "inherit",
    from: "WORKER_LOG_LEVEL",
    secret: false,
    optional: true,
    default: "info",
  },
];

async function setup(input: {
  stepDefinition?: Parameters<typeof createWorkerContext>[2];
}) {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "boboddy-claimed-step-env-"),
  );
  const callOrder: string[] = [];
  const launch = vi.fn(() => {
    callOrder.push("launch");
    return Promise.resolve({
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      opencodeLogDirectory: path.join(workspacePath, ".logs"),
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agentBaseUrl: "http://localhost:4096",
      aiImage: "boboddy/ai-worker:local",
      networkName: "test-network",
      secretValues: [],
      cleanup: () => Promise.resolve(),
    });
  });

  const workerClient = createWorkerClient();
  workerClient.getStepExecutionWorkerContext = vi.fn(() =>
    Promise.resolve(
      createWorkerContext("workspace", null, input.stepDefinition),
    ),
  );

  const tracker = createRunTracker();
  const logStream = {
    registerSecretValues: vi.fn((values: readonly string[]) => {
      callOrder.push(`registerSecretValues:${values.join(",")}`);
    }),
    attachOpencodeTail: vi.fn(() => {
      callOrder.push("attachOpencodeTail");
    }),
    attachConversationStream: vi.fn(),
    shipDevcontainerLogLine: vi.fn(),
  };
  const deps = {
    workerClient,
    createRunTracker: () => tracker,
    runtimeEnvironmentOrchestrator: { launch },
    agentRunner: {
      promptAsync: vi.fn(() =>
        Promise.resolve({ sessionId: "agent-session-id" }),
      ),
      getSessionStatus: vi.fn(),
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: { saveArtifact: vi.fn() },
    sleep: vi.fn(() => Promise.resolve(undefined)),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
  } satisfies ProcessProjectWorkDeps;

  const run = (workerEnv?: Record<string, string | undefined>) =>
    startProcessClaimedExecution(
      {
        projectId,
        requestedByUserId,
        claim: {
          stepExecution: { id: stepExecutionId },
          claimToken: "claim-token",
        },
        leaseDurationSeconds: 30,
        workerEnv,
      },
      deps,
      deps.workerClient,
      tracker,
      logStream,
    );

  return { run, deps, launch, tracker, logStream, callOrder };
}

describe("startProcessClaimedExecution step env", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["WAREHOUSE_TOKEN"];
  });

  test("passes the resolved step env to the runtime launch", async () => {
    const { run, launch } = await setup({
      stepDefinition: { envJson: ENV_JSON },
    });

    await run({ WAREHOUSE_TOKEN: "wh-token-value" });

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        stepEnv: {
          ACCOUNT_ID: "Checkout bug-acct",
          TENANT_API_KEY: "Checkout bug-key",
          WAREHOUSE_TOKEN: "wh-token-value",
          LOG_LEVEL: "info",
        },
      }),
    );
  });

  test("inherits from the supplied workerEnv, not the ambient process.env", async () => {
    process.env["WAREHOUSE_TOKEN"] = "ambient-token-value";
    const { run, launch } = await setup({
      stepDefinition: { envJson: ENV_JSON },
    });

    await run({ WAREHOUSE_TOKEN: "dotenv-token-value" });

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        stepEnv: {
          ACCOUNT_ID: "Checkout bug-acct",
          TENANT_API_KEY: "Checkout bug-key",
          WAREHOUSE_TOKEN: "dotenv-token-value",
          LOG_LEVEL: "info",
        },
      }),
    );
  });

  test("launches with an empty step env when the step declares none", async () => {
    const { run, launch } = await setup({});

    await run({});

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ stepEnv: {} }),
    );
  });

  test("registers secret values with the log masker before launch and before the log tail attaches", async () => {
    const { run, logStream, callOrder } = await setup({
      stepDefinition: { envJson: ENV_JSON },
    });

    await run({ WAREHOUSE_TOKEN: "wh-token-value" });

    expect(logStream.registerSecretValues).toHaveBeenCalledWith([
      "Checkout bug-key",
      "wh-token-value",
    ]);
    const registered = callOrder.findIndex((entry) =>
      entry.startsWith("registerSecretValues:Checkout bug-key"),
    );
    expect(registered).toBeGreaterThanOrEqual(0);
    expect(registered).toBeLessThan(callOrder.indexOf("launch"));
    expect(registered).toBeLessThan(callOrder.indexOf("attachOpencodeTail"));
  });

  test("fails before launch, naming every missing required variable and no values", async () => {
    const { run, launch, tracker, deps } = await setup({
      stepDefinition: {
        envJson: [
          ...ENV_JSON,
          {
            name: "DB_PASSWORD",
            source: "inherit",
            from: "STAGING_DB_PASSWORD",
            secret: true,
            optional: false,
          },
        ],
      },
    });

    let caught: unknown;
    try {
      await run({ UNRELATED: "should-not-appear-anywhere" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("WAREHOUSE_TOKEN");
    expect(message).toContain("STAGING_DB_PASSWORD");
    expect(message).not.toContain("should-not-appear-anywhere");
    expect(launch).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading through a plain object, not a class instance
    expect(tracker.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: message }),
    );
    expect(deps.agentRunner.promptAsync).not.toHaveBeenCalled();
  });

  test("a step that declares env renders only declared, non-secret variables in its prompt", async () => {
    const { run, deps } = await setup({
      stepDefinition: {
        prompt:
          "Account {{env.ACCOUNT_ID}} key=[{{env.TENANT_API_KEY}}] token=[{{env.WAREHOUSE_TOKEN}}] ambient=[{{env.HOME_DIR}}].",
        envJson: ENV_JSON,
      },
    });

    await run({
      WAREHOUSE_TOKEN: "wh-token-value",
      HOME_DIR: "/should/not/render",
    });

    expect(deps.agentRunner.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText:
          "Header\nAccount Checkout bug-acct key=[] token=[] ambient=[].\nFooter",
      }),
    );
  });

  test("a step without env keeps the worker environment available to its prompt", async () => {
    const { run, deps } = await setup({
      stepDefinition: { prompt: "Open {{env.BASE_URL}}." },
    });

    await run({ BASE_URL: "https://dotenv.example.com" });

    expect(deps.agentRunner.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: "Header\nOpen https://dotenv.example.com.\nFooter",
      }),
    );
  });
});
