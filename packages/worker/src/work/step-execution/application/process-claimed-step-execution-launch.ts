/**
 * Worker-context fetching and runtime-environment launch, used by
 * `process-claimed-step-execution.ts`. Split out purely to keep that module
 * under the repo's per-file line limit.
 */
import { parseUuidV7, type UuidV7 } from "../../../common/contracts/uuid-v7";
import { resolveBaseWorkBranch } from "./process-claimed-step-execution-helpers";
import type {
  ProcessProjectWorkDeps,
  StepExecutionWorkerClaim,
  StepExecutionWorkerClient,
} from "../contracts/process-project-work-types";
import type { WorkReporter } from "../contracts/work-reporter";

export async function fetchWorkerContext(
  client: StepExecutionWorkerClient,
  claim: StepExecutionWorkerClaim,
) {
  return await client.getStepExecutionWorkerContext({
    stepExecutionId: claim.stepExecution.id,
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
    localRuntimeSessionId: UuidV7;
    workerContext: Awaited<ReturnType<typeof fetchWorkerContext>>;
    requestedByUserId: UuidV7;
    reporter: WorkReporter;
    stepExecutionId: string;
    sourceBranch?: string | null | undefined;
    onDevcontainerLogLine?:
      | ((line: string, level: "info" | "warn" | "error") => void)
      | undefined;
    /** See `StepExecutionRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    fakeAiProviderOverride?: { baseUrl: string } | undefined;
  },
) {
  const orchestrator = resolveRuntimeEnvironmentOrchestrator(
    deps,
    input.workerContext.stepDefinition.executionMode,
  );
  return await orchestrator.launch({
    sessionId: input.localRuntimeSessionId,
    projectId: parseUuidV7(input.workerContext.projectId),
    requestedByUserId: input.requestedByUserId,
    gitUrl: input.workerContext.gitUrl,
    baseWorkBranch: resolveBaseWorkBranch(input.workerContext.baseWorkBranch),
    sourceBranch: input.sourceBranch,
    stepKey: input.workerContext.stepDefinition.key,
    opencodeMcpJson: input.workerContext.stepDefinition.opencodeMcpJson,
    opencodePluginJson: input.workerContext.stepDefinition.opencodePluginJson,
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
      stepExecutionId: input.workerContext.stepExecution.id,
      resultSchemaJson: input.workerContext.stepDefinition.resultSchemaJson,
    },
    reporter: input.reporter,
    stepExecutionId: input.stepExecutionId,
    onDevcontainerLogLine: input.onDevcontainerLogLine,
    fakeAiProviderOverride: input.fakeAiProviderOverride,
  });
}
