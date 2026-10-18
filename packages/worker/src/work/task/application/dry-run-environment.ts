import {
  toOpencodeServerHandle,
  type OpencodeServerHandle,
} from "../../../runtime/runtime-service/infra/opencode-server-contract";
import type {
  TaskRuntimeEnvironment,
  TaskRuntimeEnvironmentOrchestrator,
} from "../contracts/process-project-work-types";
import {
  checkOpencodeHealth,
  pollMcpStatus,
  type McpHandshakeReport,
} from "./run-work-dry-run-health-checks";
import { logWorkError } from "./work-logger";

/**
 * One dry-run launch: bring an environment up, probe it, hand the running
 * agent to `run`, then tear it down. Shared by `work --dry-run` (one step, or
 * global-only) and the run-offer gate (every step's health checks, one launch
 * per runtime), so both rehearse the same launch path and neither can leak a
 * container: teardown runs in a `finally`, whatever `run` or the probe does,
 * unless the caller asked to keep it.
 */

export type DryRunEnvironmentHealth = {
  containerHealth: { status: string; healthy: boolean } | null;
  opencodeHealth: { healthy: boolean; detail?: string | undefined };
  /** Handshake status per configured MCP server. */
  mcpServers: McpHandshakeReport[];
};

export type DryRunLaunchInput = Parameters<
  TaskRuntimeEnvironmentOrchestrator["launch"]
>[0];

export type DryRunEnvironmentOutcome<T> =
  | { kind: "launch-failed"; reason: string }
  | {
      kind: "ran";
      health: DryRunEnvironmentHealth;
      result: T;
      workspacePath: string;
      runtimeContainerId: string | null;
      agentBaseUrl: string;
      kept: boolean;
    };

export type ProbeDryRunEnvironment = (input: {
  environment: TaskRuntimeEnvironment;
  server: OpencodeServerHandle;
  agentVersion: string;
}) => Promise<DryRunEnvironmentHealth>;

export const probeDryRunEnvironment: ProbeDryRunEnvironment = async ({
  environment,
  server,
  agentVersion,
}) => {
  const containerHealth =
    environment.runtimeContainerId && environment.checkContainerHealth
      ? await environment.checkContainerHealth().then((result) => ({
          status: result.runtimeContainerStatus,
          healthy: ["healthy", "running"].includes(
            result.runtimeContainerStatus,
          ),
        }))
      : null;
  const opencodeHealth = await checkOpencodeHealth(server, agentVersion);
  const mcpServers = await pollMcpStatus(server);
  return { containerHealth, opencodeHealth, mcpServers };
};

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runInDryRunEnvironment<T>(input: {
  orchestrator: TaskRuntimeEnvironmentOrchestrator;
  launchInput: DryRunLaunchInput;
  /** Preserve the environment instead of tearing it down (`--keep`). */
  keep: boolean;
  /** Called once the environment is up, before it is probed. */
  onLaunched?: (() => void) | undefined;
  run: (
    server: OpencodeServerHandle,
    environment: TaskRuntimeEnvironment,
  ) => Promise<T>;
  probe?: ProbeDryRunEnvironment | undefined;
}): Promise<DryRunEnvironmentOutcome<T>> {
  let environment: TaskRuntimeEnvironment;
  try {
    environment = await input.orchestrator.launch(input.launchInput);
  } catch (error) {
    return { kind: "launch-failed", reason: errorMessage(error) };
  }

  try {
    input.onLaunched?.();
    const { agent } = environment;
    if (!agent) {
      throw new Error(
        "Dry-run runtime environment launched without an agent although one was requested",
      );
    }
    const server = toOpencodeServerHandle(agent, environment.workspaceFolder);
    const health = await (input.probe ?? probeDryRunEnvironment)({
      environment,
      server,
      agentVersion: agent.version,
    });
    const result = await input.run(server, environment);
    return {
      kind: "ran",
      health,
      result,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: agent.baseUrl,
      kept: input.keep,
    };
  } finally {
    if (!input.keep) {
      // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
      await environment.cleanup().catch((error: unknown) => {
        logWorkError("dry-run", "Failed to tear down the dry-run environment", {
          runtimeContainerId: environment.runtimeContainerId,
          error: errorMessage(error),
        });
      });
    }
  }
}
