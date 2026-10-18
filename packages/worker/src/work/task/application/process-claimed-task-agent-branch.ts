/**
 * The agent branch (`user_defined` / `built_in` kinds) of
 * `startProcessClaimedTask`: renders the step prompt and starts the
 * OpenCode session. Returns the real agent session id.
 */
import { renderPromptTemplate } from "@boboddy/sdk/definitions/steps";
import {
  buildContainerStepArtifactsDir,
  buildPromptRenderContext,
} from "./process-claimed-task-helpers";
import { toOpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";
import type {
  OpencodeServerHandle,
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  TaskRuntimeEnvironment,
  TaskWorkerContext,
  WorkReporter,
} from "../contracts/process-project-work-types";

export async function runAgentStepBranch(input: {
  deps: ProcessProjectWorkDeps;
  logger: ProjectWorkLogger;
  reporter: WorkReporter;
  workerContext: TaskWorkerContext;
  environment: TaskRuntimeEnvironment;
  taskId: string;
  localRuntimeSessionId: string;
  stepArtifactsDir: string;
  workerEnv: Readonly<Record<string, string | undefined>>;
  promptEnv: Readonly<Record<string, string>>;
  onSessionCreated: (sessionId: string, server: OpencodeServerHandle) => void;
}): Promise<string> {
  const { workerContext, environment } = input;
  const { agent } = environment;
  if (!agent) {
    throw new Error(
      "Runtime environment launched without an agent although the step requires one",
    );
  }

  // Render the prompt now that the runtime is up: artifact paths embedded in
  // the prompt must be anchored at the resolved workspace folder OpenCode
  // operates against (no longer a hardcoded `/workspace`).
  const containerStepArtifactsDir = buildContainerStepArtifactsDir(
    environment.workspaceFolder,
  );
  if (!workerContext.task.prompt) {
    throw new Error(
      `Task ${workerContext.task.id} does not have an agent prompt`,
    );
  }
  const renderedStepInstructions = renderPromptTemplate(
    workerContext.task.prompt,
    buildPromptRenderContext({
      inputJson: workerContext.task.inputJson,
      env: input.workerEnv,
      promptEnv: workerContext.runtime.envJson?.length
        ? input.promptEnv
        : undefined,
      artifactsDir: `${containerStepArtifactsDir}/`,
    }),
  );
  const resolvedPromptText = workerContext.agentPrompt.promptText.replaceAll(
    workerContext.agentPrompt.instructionsPlaceholder,
    renderedStepInstructions,
  );

  // Request-size diagnostic: the OpenAI ChatGPT/OAuth path is far more likely
  // to fail mid-stream on large requests, and request size here is dominated
  // by the user prompt plus every configured MCP server's tool schemas. Log a
  // profile so oversized runs are identifiable from worker logs alone.
  const stepMcpServerNames = Object.keys(
    workerContext.runtime.opencodeMcpJson ?? {},
  );
  input.logger.log("step", "Prepared step prompt request profile", {
    taskId: input.taskId,
    localRuntimeSessionId: input.localRuntimeSessionId,
    userPromptChars: resolvedPromptText.length,
    mcpServerCount: stepMcpServerNames.length,
    mcpServerNames: stepMcpServerNames,
  });

  input.logger.log("step", "Starting agent run", {
    taskId: input.taskId,
    localRuntimeSessionId: input.localRuntimeSessionId,
    agentBaseUrl: agent.baseUrl,
    sessionTitle: workerContext.agentPrompt.sessionTitle,
    stepArtifactsDir: input.stepArtifactsDir,
  });
  input.reporter.event({
    type: "task:agent-running",
    taskId: input.taskId,
  });
  const server = toOpencodeServerHandle(agent, environment.workspaceFolder);
  const agentRunResult = await input.deps.agentRunner.promptAsync({
    server,
    sessionTitle: workerContext.agentPrompt.sessionTitle,
    promptText: resolvedPromptText,
    agent: "build",
    // Attach the conversation-event subscription the moment the session
    // exists, but before the prompt itself is submitted. OpenCode
    // broadcasts the initial user message's `message.part.updated` event
    // exactly once, synchronously as part of handling the prompt request —
    // attaching afterward (as this used to) loses that event to the race.
    onSessionCreated: ({ sessionId }) => {
      input.onSessionCreated(sessionId, server);
    },
  });
  input.logger.log("step", "Agent session started", {
    taskId: input.taskId,
    agentSessionId: agentRunResult.sessionId,
  });
  return agentRunResult.sessionId;
}
