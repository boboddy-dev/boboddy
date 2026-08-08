/**
 * Shared fixtures for `process-claimed-step-execution*.test.ts`. Split out so
 * neither test file has to duplicate this scaffolding, and so both stay
 * under the repo's per-file line limit.
 */
import { vi } from "bun:test";
import { parseUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import { startProcessClaimedExecution } from "../../../../../src/work/step-execution/application/process-claimed-step-execution";
import type {
  ProcessProjectWorkDeps,
  StepExecutionRunTracker,
  StepExecutionWorkerClient,
  StepExecutionWorkerContext,
} from "../../../../../src/work/step-execution/contracts/process-project-work-types";

export const projectId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001");
export const requestedByUserId = parseUuidV7(
  "01966a2c-9494-7db5-aa46-0f8f5cbbe002",
);
export const stepExecutionId = parseUuidV7(
  "01966a2c-9494-7db5-aa46-0f8f5cbbe003",
);
export const stepDefinitionId = parseUuidV7(
  "01966a2c-9494-7db5-aa46-0f8f5cbbe004",
);

export function createWorkerContext(
  executionMode?: "workspace" | "no_workspace",
  healthChecksJson?: StepExecutionWorkerContext["stepDefinition"]["healthChecksJson"],
): StepExecutionWorkerContext {
  const resolvedExecutionMode = executionMode ?? "workspace";
  const resolvedHealthChecksJson = healthChecksJson ?? null;
  return {
    projectId,
    gitUrl: "https://github.com/example/repo.git",
    projectOpencodeConfig: {
      relativePath: ".boboddy/boboddy.jsonc",
      present: false,
      commands: [],
      services: [],
    },
    stepExecution: {
      id: stepExecutionId,
      status: "running",
      inputJson: { title: "Checkout bug" },
      executionTimeoutSeconds: 120,
    },
    stepDefinition: {
      id: stepDefinitionId,
      key: "demo-step",
      name: "Demo Step",
      prompt:
        "Open {{env.BASE_URL}} for {{input.title}} and save to {{boboddy.artifactsDir}}trace.zip. Legacy: {{title}} and {{stepArtifactsDir}}trace.zip.",
      executionMode: resolvedExecutionMode,
      resultSchemaJson: { type: "object" },
      opencodeMcpJson: null,
      opencodePluginJson: null,
      healthChecksJson: resolvedHealthChecksJson,
    },
    agentPrompt: {
      sessionTitle: "Demo Step",
      promptText: "Header\n__BOBODDY_STEP_INSTRUCTIONS__\nFooter",
      stepInstructionsPlaceholder: "__BOBODDY_STEP_INSTRUCTIONS__",
    },
  };
}

export function createRunTracker(): StepExecutionRunTracker {
  return {
    createSession: vi.fn(() => Promise.resolve(undefined)),
    markRunning: vi.fn(() => Promise.resolve(undefined)),
    attachAgentSession: vi.fn(() => Promise.resolve(undefined)),
    markSucceeded: vi.fn(() => Promise.resolve(undefined)),
    markFailed: vi.fn(() => Promise.resolve(undefined)),
    close: vi.fn(() => Promise.resolve(undefined)),
  };
}

export function createWorkerClient(
  executionMode: "workspace" | "no_workspace" = "workspace",
): StepExecutionWorkerClient {
  return {
    userId: requestedByUserId,
    claimStepExecutions: vi.fn(),
    heartbeatStepExecution: vi.fn(),
    failStepExecution: vi.fn(),
    completeStepExecution: vi.fn(),
    appendStepExecutionLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    getStepExecution: vi.fn(),
    getStepExecutionWorkerContext: vi.fn(() =>
      Promise.resolve(createWorkerContext(executionMode)),
    ),
    createArtifactUploadUrl: vi.fn(),
    recordArtifact: vi.fn(),
  };
}

export function runClaim(deps: ProcessProjectWorkDeps) {
  return startProcessClaimedExecution(
    {
      projectId,
      requestedByUserId,
      claim: {
        stepExecution: { id: stepExecutionId },
        claimToken: "claim-token",
      },
      leaseDurationSeconds: 30,
    },
    deps,
    deps.workerClient,
    createRunTracker(),
  );
}
