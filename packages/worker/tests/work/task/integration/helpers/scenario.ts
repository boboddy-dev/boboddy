import type { RepoConfig } from "@boboddy/sdk/repo-config";
import type { UuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type { TaskWorkerContextContract } from "../../../../../src/work/task/contracts/task-contracts";

/**
 * Per-test description of the server-side behavior the work command will see.
 *
 * The fake TaskWorkerClient is driven entirely by this config:
 * which jobs to claim, what worker context to return for each claimed step,
 * and (separately) the AI findings the fake AI server submits.
 */
export type WorkScenarioStep = {
  taskId: UuidV7;
  /**
   * Worker context returned by getTaskWorkerContext for this step.
   * gitUrl is irrelevant (clone is faked) but must be a non-empty string.
   */
  workerContext: TaskWorkerContextContract;
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
 * task. The result schema is permissive (any object) so the
 * configured findings always validate.
 */
export function buildSingleStepScenario(input: {
  projectId: UuidV7;
  taskId: UuidV7;
  prompt?: string;
  resultSchemaJson?: Record<string, unknown> | null;
  findings: unknown;
  /** Repo-relative devcontainer config the step selects; `null` auto-detects. */
  devcontainerConfigPath?: string | null;
  /** The managed runtime identifier a code step runs in; `null` is not managed. */
  managedRuntime?: string | null;
  /** The step's resolved repo access; defaults to a read-write step. */
  repo?: RepoConfig;
  /** The task's additional input (the `{{input.…}}` token source). */
  inputJson?: unknown;
  /** When set, the step is `kind: "code"` and runs this entrypoint instead of prompting. */
  codeEntrypoint?: { sourceFile: string };
  /** Makes the step a steered rerun of this previous run. */
  previousRun?: TaskWorkerContextContract["previousRun"];
}): WorkScenario {
  const resultSchemaJson =
    input.resultSchemaJson === undefined
      ? { type: "object", additionalProperties: true }
      : input.resultSchemaJson;

  const workerContext: TaskWorkerContextContract = {
    projectId: input.projectId,
    gitUrl: "https://github.com/boboddy-dev/integration-dummy.git",
    projectOpencodeConfig: {
      relativePath: ".boboddy/boboddy.jsonc",
      present: false,
      commands: [],
      services: [],
    },
    task: {
      id: input.taskId,
      status: "running",
      kind: input.codeEntrypoint ? "code" : "agent",
      key: "integration-step",
      name: "Integration Step",
      inputJson: input.inputJson ?? null,
      executionTimeoutSeconds: 300,
      prompt: input.codeEntrypoint
        ? null
        : (input.prompt ?? "Complete the integration step."),
      entrypointJson: input.codeEntrypoint ?? null,
      resultSchemaJson,
    },
    runtime: {
      executionMode: "workspace",
      devcontainerConfigPath: input.devcontainerConfigPath ?? null,
      managedRuntime: input.managedRuntime ?? null,
      repo: input.repo ?? {
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
      },
      envJson: null,
      healthChecksJson: null,
      opencodeMcpJson: null,
    },
    agentPrompt: {
      sessionTitle: "Integration Step",
      promptText: "Complete the integration step.",
      instructionsPlaceholder: "__BOBODDY_STEP_INSTRUCTIONS__",
    },
    previousRun: input.previousRun ?? null,
  };

  return {
    projectId: input.projectId,
    steps: [{ taskId: input.taskId, workerContext }],
    findings: input.findings,
  };
}
