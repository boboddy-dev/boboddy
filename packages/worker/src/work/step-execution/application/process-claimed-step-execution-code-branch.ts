/**
 * The `kind === "code"` branch of `startProcessClaimedExecution`: runs the
 * step's entrypoint as a plain function in the devcontainer (the project's, or
 * for a managed runtime the worker-supplied one). No agent exists
 * for such a step, so there is no agent session to attach or report.
 */
import { resolveManagedRuntime } from "../../../runtime/runtime-service/domain/managed-runtimes";
import { executeCodeStep } from "./execute-code-step";
import type {
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  StepExecutionRuntimeEnvironment,
  StepExecutionWorkerContext,
  WorkReporter,
} from "../contracts/process-project-work-types";

export async function runCodeStepBranch(input: {
  deps: ProcessProjectWorkDeps;
  logger: ProjectWorkLogger;
  reporter: WorkReporter;
  workerContext: StepExecutionWorkerContext;
  environment: StepExecutionRuntimeEnvironment;
  stepExecutionId: string;
  localRuntimeSessionId: string;
  stepEnv: Readonly<Record<string, string>>;
}): Promise<void> {
  const { workerContext, environment } = input;
  const entrypointJson = workerContext.stepDefinition.entrypointJson;
  if (!entrypointJson) {
    throw new Error(
      `Step definition ${workerContext.stepDefinition.id} is kind "code" but has no entrypointJson`,
    );
  }

  const { managedRuntime } = workerContext.stepDefinition;
  const runtime = managedRuntime
    ? resolveManagedRuntime(managedRuntime).definition.runtime
    : undefined;

  input.logger.log("step", "Starting code step execution", {
    stepExecutionId: input.stepExecutionId,
    localRuntimeSessionId: input.localRuntimeSessionId,
    sourceFile: entrypointJson.sourceFile,
    stepKey: workerContext.stepDefinition.key,
  });
  input.reporter.event({
    type: "step:agent-running",
    stepExecutionId: input.stepExecutionId,
  });

  await executeCodeStep(
    {
      environment: {
        workspacePath: environment.workspacePath,
        workspaceFolder: environment.workspaceFolder,
        runtimeContainerId: environment.runtimeContainerId,
      },
      entrypointJson,
      stepKey: workerContext.stepDefinition.key,
      runtime,
      inputJson: workerContext.stepExecution.inputJson,
      stepEnv: input.stepEnv,
    },
    { runCommand: input.deps.runCodeStepCommand },
  );
  input.logger.log("step", "Code step execution completed", {
    stepExecutionId: input.stepExecutionId,
    localRuntimeSessionId: input.localRuntimeSessionId,
  });
}
