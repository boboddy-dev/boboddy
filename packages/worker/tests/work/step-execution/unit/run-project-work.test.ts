import { afterEach, describe, expect, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import type {
  StepExecutionAgentRunner,
  StepExecutionRunTracker,
  StepExecutionRuntimeEnvironmentOrchestrator,
  StepExecutionWorkerClient,
  StepExecutionWorkerContext,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";
import { processProjectWork } from "../../../../src/work/step-execution/application/run-project-work";
import { concurrentTest } from "../../../utils";

const projectId = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";
const userId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002");
const stepExecutionId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004");

function createRunTracker(): StepExecutionRunTracker {
  return {
    createSession: vi.fn(),
    markRunning: vi.fn(),
    attachAgentSession: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    close: vi.fn(),
  };
}

function createWorkerClient(
  overrides?: Partial<StepExecutionWorkerClient>,
): StepExecutionWorkerClient {
  const claimStepExecutions: StepExecutionWorkerClient["claimStepExecutions"] =
    vi.fn(() => Promise.resolve([]));
  const heartbeatStepExecution: StepExecutionWorkerClient["heartbeatStepExecution"] =
    vi.fn(() => Promise.resolve(undefined));
  const failStepExecution: StepExecutionWorkerClient["failStepExecution"] =
    vi.fn(() => Promise.resolve(undefined));
  const completeStepExecution: StepExecutionWorkerClient["completeStepExecution"] =
    vi.fn(() => Promise.resolve(undefined));
  const getStepExecution: StepExecutionWorkerClient["getStepExecution"] = vi.fn(
    () => Promise.resolve({ status: "succeeded" as const }),
  );
  const getStepExecutionWorkerContext: StepExecutionWorkerClient["getStepExecutionWorkerContext"] =
    vi.fn(() =>
      Promise.resolve({
        projectId: parseUuidV7(projectId),
        gitUrl: "https://github.com/example/repo.git",
        requestedBranch: null,
        projectOpencodeConfig: {
          relativePath: ".boboddy/boboddy.jsonc",
          present: false,
          commands: [],
          services: [],
        },
        stepExecution: {
          id: stepExecutionId,
          status: "running",
          inputJson: null,
          executionTimeoutSeconds: 120,
        },
        stepDefinition: {
          id: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003"),
          key: "demo-step",
          name: "Demo Step",
          prompt: "Run the demo step.",
          resultSchemaJson: { type: "object" },
          opencodeMcpJson: null,
          opencodePluginJson: null,
        },
        agentPrompt: {
          sessionTitle: "Demo Step",
          promptText: "Run it.",
          stepInstructionsPlaceholder: "__BOBODDY_STEP_INSTRUCTIONS__",
        },
      } satisfies StepExecutionWorkerContext),
    );
  return {
    userId,
    claimStepExecutions,
    heartbeatStepExecution,
    failStepExecution,
    completeStepExecution,
    appendStepExecutionLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    getStepExecution,
    getStepExecutionWorkerContext,
    createArtifactUploadUrl: vi.fn(() =>
      Promise.resolve({
        uploadUrl: "https://fake-upload.local/artifact",
        storeRef: "remote://artifact",
        objectKey: "artifact",
        expiresInSeconds: 300,
      }),
    ),
    recordArtifact: vi.fn(() => Promise.resolve(undefined)),
    ...overrides,
  };
}

describe("CLI processProjectWork", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  concurrentTest(
    "resolves the base URL and default worker settings before delegating to core",
    async () => {
      const claimStepExecutions: StepExecutionWorkerClient["claimStepExecutions"] =
        vi.fn(() => Promise.resolve([]));
      const workerClient = createWorkerClient({ claimStepExecutions });
      const createWorkerClientForBaseUrl = vi.fn(() =>
        Promise.resolve(workerClient),
      );

      const result = await processProjectWork(
        {
          projectId,
          baseUrl: "https://example.com///",
          once: true,
        },
        {
          createWorkerClient: createWorkerClientForBaseUrl,
          createRunTracker,
          runtimeEnvironmentOrchestrator: {
            launch: vi.fn(() => Promise.reject(new Error("Not used"))),
          } satisfies StepExecutionRuntimeEnvironmentOrchestrator,
          agentRunner: {
            promptAsync: vi.fn(() => Promise.reject(new Error("Not used"))),
            getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
            sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
          } satisfies StepExecutionAgentRunner,
          sleep: () => Promise.resolve(undefined),
          logger: {
            debug: vi.fn(),
            log: vi.fn(),
            error: vi.fn(),
          },
        },
      );

      expect(createWorkerClientForBaseUrl).toHaveBeenCalledWith(
        "https://example.com",
      );
      expect(claimStepExecutions).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: parseUuidV7(projectId),
          batchSize: 1,
          leaseDurationSeconds: 30,
        }),
      );
      expect(result).toEqual({
        claimedCount: 0,
        processedCount: 0,
        skippedCount: 0,
      });
    },
  );

  concurrentTest(
    "uses concurrency as the default batch size when batch size is omitted",
    async () => {
      const claimStepExecutions: StepExecutionWorkerClient["claimStepExecutions"] =
        vi.fn(() => Promise.resolve([]));
      const workerClient = createWorkerClient({ claimStepExecutions });

      await processProjectWork(
        {
          projectId,
          concurrency: 2,
          workerId: "worker-2",
          once: true,
        },
        {
          createWorkerClient: () => Promise.resolve(workerClient),
          createRunTracker,
          runtimeEnvironmentOrchestrator: {
            launch: vi.fn(() => Promise.reject(new Error("Not used"))),
          } satisfies StepExecutionRuntimeEnvironmentOrchestrator,
          agentRunner: {
            promptAsync: vi.fn(() => Promise.reject(new Error("Not used"))),
            getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
            sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
          } satisfies StepExecutionAgentRunner,
          sleep: () => Promise.resolve(undefined),
          logger: {
            debug: vi.fn(),
            log: vi.fn(),
            error: vi.fn(),
          },
        },
      );

      expect(claimStepExecutions).toHaveBeenCalledWith({
        projectId: parseUuidV7(projectId),
        workerId: "worker-2",
        batchSize: 2,
        leaseDurationSeconds: 30,
      });
    },
  );

  concurrentTest(
    "uses prod url as the default base URL when no base URL is configured",
    async () => {
      const workerClient = createWorkerClient();
      const createWorkerClientForBaseUrl = vi.fn(() =>
        Promise.resolve(workerClient),
      );
      const previousBaseUrl = process.env["BOBODDY_BASE_URL"];

      delete process.env["BOBODDY_BASE_URL"];

      try {
        await processProjectWork(
          {
            projectId,
            once: true,
          },
          {
            createWorkerClient: createWorkerClientForBaseUrl,
            createRunTracker,
            runtimeEnvironmentOrchestrator: {
              launch: vi.fn(() => Promise.reject(new Error("Not used"))),
            } satisfies StepExecutionRuntimeEnvironmentOrchestrator,
            agentRunner: {
              promptAsync: vi.fn(() => Promise.reject(new Error("Not used"))),
              getSessionStatus: vi.fn(() =>
                Promise.resolve({ running: false }),
              ),
              sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
            } satisfies StepExecutionAgentRunner,
            sleep: () => Promise.resolve(undefined),
            logger: {
              debug: vi.fn(),
              log: vi.fn(),
              error: vi.fn(),
            },
          },
        );
      } finally {
        if (previousBaseUrl === undefined) {
          delete process.env["BOBODDY_BASE_URL"];
        } else {
          process.env["BOBODDY_BASE_URL"] = previousBaseUrl;
        }
      }

      expect(createWorkerClientForBaseUrl).toHaveBeenCalledWith(
        "https://app.boboddy.dev",
      );
    },
  );
});
