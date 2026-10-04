import type {
  AgentRuntime,
  StartedClaimedExecution,
} from "../contracts/process-project-work-types";
import { buildFindingsSubmissionPath } from "./process-project-work-findings";

/**
 * How the monitor observes a started execution. An AI step has an agent runtime
 * and a session to poll; a code step has neither and its findings are already
 * on disk by the time the monitor starts.
 */
export type MonitorAgentContext =
  | { mode: "agent"; agent: AgentRuntime; agentSessionId: string }
  | { mode: "none" };

export function resolveMonitorAgentContext(
  startedExecution: StartedClaimedExecution,
): MonitorAgentContext {
  const { agent } = startedExecution.environment;
  const { agentSessionId } = startedExecution;

  if (agent && agentSessionId !== null) {
    return { mode: "agent", agent, agentSessionId };
  }
  if (!agent && agentSessionId === null) {
    return { mode: "none" };
  }
  throw new Error(
    "Started execution must have an agent runtime and an agent session id together, or neither",
  );
}

export function buildCodeStepMissingFindingsError(
  workspacePath: string,
): Error {
  return new Error(
    `Code step finished without writing its findings file (${buildFindingsSubmissionPath(workspacePath)})`,
  );
}
