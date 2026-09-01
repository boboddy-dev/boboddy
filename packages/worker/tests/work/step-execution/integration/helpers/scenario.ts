import type { UuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type { StepExecutionWorkerContextContract } from "../../../../../src/work/step-execution/contracts/step-execution-contracts";

/**
 * Per-test description of the server-side behavior the work command will see.
 *
 * The fake StepExecutionWorkerClient is driven entirely by this config:
 * which jobs to claim, what worker context to return for each claimed step,
 * and (separately) the AI findings the fake AI server submits.
 */
export type WorkScenarioStep = {
  stepExecutionId: UuidV7;
  /**
   * Worker context returned by getStepExecutionWorkerContext for this step.
   * gitUrl is irrelevant (clone is faked) but must be a non-empty string.
   */
  workerContext: StepExecutionWorkerContextContract;
};

export type WorkScenario = {
  projectId: UuidV7;
  /**
   * Steps the worker client will hand out in a single claim batch. After the
   * first claim the client returns [] so the polling loop terminates (with
   * `once: true`).
   */
  steps: WorkScenarioStep[];
  /** Findings JSON the fake AI agent submits via boboddy-submit-step-findings. */
  findings: unknown;
};

/**
 * Builds a minimal single-step scenario whose worker context drives a real
 * step execution. The result schema is permissive (any object) so the
 * configured findings always validate.
 */
export function buildSingleStepScenario(input: {
  projectId: UuidV7;
  stepExecutionId: UuidV7;
  stepDefinitionId: UuidV7;
  prompt?: string;
  resultSchemaJson?: Record<string, unknown> | null;
  findings: unknown;
}): WorkScenario {
  const resultSchemaJson =
    input.resultSchemaJson === undefined
      ? { type: "object", additionalProperties: true }
      : input.resultSchemaJson;

  const workerContext: StepExecutionWorkerContextContract = {
    projectId: input.projectId,
    gitUrl: "https://github.com/boboddy-dev/integration-dummy.git",
    projectOpencodeConfig: {
      relativePath: ".boboddy/boboddy.jsonc",
      present: false,
      commands: [],
      services: [],
    },
    stepExecution: {
      id: input.stepExecutionId,
      status: "running",
      inputJson: null,
      executionTimeoutSeconds: 300,
    },
    stepDefinition: {
      id: input.stepDefinitionId,
      key: "integration-step",
      name: "Integration Step",
      prompt: input.prompt ?? "Complete the integration step.",
      kind: "user_defined",
      entrypointJson: null,
      executionMode: "workspace",
      resultSchemaJson,
      opencodeMcpJson: null,
      opencodePluginJson: null,
      healthChecksJson: null,
    },
    agentPrompt: {
      sessionTitle: "Integration Step",
      promptText: "Complete the integration step.",
      stepInstructionsPlaceholder: "__BOBODDY_STEP_INSTRUCTIONS__",
    },
  };

  return {
    projectId: input.projectId,
    steps: [{ stepExecutionId: input.stepExecutionId, workerContext }],
    findings: input.findings,
  };
}
