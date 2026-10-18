/**
 * Worker-context fetching and runtime-environment launch, used by
 * `process-claimed-task.ts`. Split out purely to keep that module
 * under the repo's per-file line limit.
 */
import { parseUuidV7, type UuidV7 } from "../../../common/contracts/uuid-v7";
import { resolveBaseWorkBranch } from "./process-claimed-task-helpers";
import type { McpEnvRef, ResolvedStepEnv } from "./resolve-step-env";
import type {
  ProcessProjectWorkDeps,
  TaskWorkerClaim,
  TaskWorkerClient,
} from "../contracts/process-project-work-types";
import type { TaskWorkerContextContract } from "../contracts/task-contracts";
import type { WorkReporter } from "../contracts/work-reporter";
import type { PreviousRunFilesInput } from "./write-previous-run-files";

export async function fetchWorkerContext(
  client: TaskWorkerClient,
  claim: TaskWorkerClaim,
) {
  return await client.getTaskWorkerContext({
    taskId: claim.task.id,
    claimToken: claim.claimToken,
  });
}

/**
 * Select the runtime orchestrator for the step's execution mode. `no_workspace`
 * steps run OpenCode directly on the host (no clone, no devcontainer) via the
 * dedicated orchestrator; everything else uses the default workspace path.
 */
function resolveRuntimeEnvironmentOrchestrator(
  deps: ProcessProjectWorkDeps,
  executionMode: "workspace" | "no_workspace",
) {
  if (executionMode === "no_workspace") {
    if (!deps.noWorkspaceRuntimeEnvironmentOrchestrator) {
      throw new Error(
        "Step requires no_workspace execution mode but no " +
          "noWorkspaceRuntimeEnvironmentOrchestrator is configured.",
      );
    }
    return deps.noWorkspaceRuntimeEnvironmentOrchestrator;
  }
  return deps.runtimeEnvironmentOrchestrator;
}

export async function launchRuntimeEnvironment(
  deps: ProcessProjectWorkDeps,
  input: {
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    startAgent: boolean;
    localRuntimeSessionId: UuidV7;
    workerContext: Awaited<ReturnType<typeof fetchWorkerContext>>;
    requestedByUserId: UuidV7;
    reporter: WorkReporter;
    taskId: string;
    sourceBranch?: string | null | undefined;
    onDevcontainerLogLine?:
      ((line: string, level: "info" | "warn" | "error") => void) | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    onAgentLogReady?:
      | ((log: {
          logDirectory: string;
          hostLogPath: string;
          secretValues: readonly string[];
        }) => void)
      | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    fakeAiProviderOverride?: { baseUrl: string } | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    stepEnv?: Readonly<Record<string, string>> | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    setupEnv?: Readonly<Record<string, string>> | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    resolveMcpEnv?:
      ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    preserveRuntimeOnFailure?: boolean | undefined;
  },
) {
  const { executionMode } = input.workerContext.runtime;
  if (!input.startAgent && executionMode === "no_workspace") {
    throw new Error(
      `Step "${input.workerContext.task.key}" does not use an agent but has execution mode no_workspace; no_workspace steps run OpenCode on the host and require an agent.`,
    );
  }
  const orchestrator = resolveRuntimeEnvironmentOrchestrator(
    deps,
    executionMode,
  );
  return await orchestrator.launch({
    startAgent: input.startAgent,
    sessionId: input.localRuntimeSessionId,
    projectId: parseUuidV7(input.workerContext.projectId),
    requestedByUserId: input.requestedByUserId,
    gitUrl: input.workerContext.gitUrl,
    baseWorkBranch: resolveBaseWorkBranch(input.workerContext.baseWorkBranch),
    sourceBranch: input.sourceBranch,
    stepKey: input.workerContext.task.key,
    opencodeMcpJson: input.workerContext.runtime.opencodeMcpJson,
    // The step prompt is delivered solely as the user message via promptAsync
    // below. We deliberately do NOT also set it as the build agent's system
    // prompt: doing so duplicated the entire prompt in every request (system +
    // user). On the OpenAI ChatGPT/OAuth path (store:false + encrypted
    // reasoning), that whole payload is re-uploaded on every turn and retry,
    // which inflates requests enough to trip mid-stream `server_error`s that
    // never occur for the smaller, single-message prompts used directly on a
    // workstation. Leaving this unset keeps opencode's default build agent
    // system prompt, matching local usage.
    currentExecutionInfo: {
      taskId: input.workerContext.task.id,
      resultSchemaJson: input.workerContext.task.resultSchemaJson,
    },
    reporter: input.reporter,
    taskId: input.taskId,
    onDevcontainerLogLine: input.onDevcontainerLogLine,
    onAgentLogReady: input.onAgentLogReady,
    fakeAiProviderOverride: input.fakeAiProviderOverride,
    stepEnv: input.stepEnv,
    setupEnv: input.setupEnv,
    ...(input.resolveMcpEnv ? { resolveMcpEnv: input.resolveMcpEnv } : {}),
    preserveRuntimeOnFailure: input.preserveRuntimeOnFailure,
    devcontainerConfigPath: input.workerContext.runtime.devcontainerConfigPath,
    managedRuntime: input.workerContext.runtime.managedRuntime,
    repo: input.workerContext.runtime.repo,
    stepInputJson: input.workerContext.task.inputJson,
    previousRun: buildPreviousRunFilesInput(
      deps.workerClient,
      input.workerContext,
    ),
    logger: deps.logger,
  });
}

function buildPreviousRunFilesInput(
  client: TaskWorkerClient,
  workerContext: TaskWorkerContextContract,
): PreviousRunFilesInput | undefined {
  const run = workerContext.previousRun;
  if (!run) return undefined;
  return {
    run,
    stepKey: workerContext.task.key,
    loadLogLines: async () => {
      if (!client.loadTaskLogLines) {
        return { unavailable: "this worker client cannot read task logs." };
      }
      return await client.loadTaskLogLines({ taskId: run.taskId });
    },
  };
}
