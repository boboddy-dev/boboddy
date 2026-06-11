import { buildOpencodeContext } from "@boboddy/opencode-plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeCurrentExecutionInfoFile } from "../application/process-project-work-findings";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { OpenCodePlugins } from "../../../common/contracts/opencode-plugin";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  StepExecutionRuntimeEnvironment,
  StepExecutionRuntimeEnvironmentOrchestrator,
} from "../contracts/process-project-work-types";
import type { AiContainerLauncher } from "../../../runtime/runtime-service/application/ai-container-launcher";
import type { DevcontainerLauncher } from "../../../runtime/runtime-service/application/devcontainer-launcher";
import type { GitCloneService } from "../../../runtime/runtime-service/application/git-clone-service";
import {
  PROJECT_RUNTIME_SESSION_AGENT_NETWORK_ALIAS,
  PROJECT_RUNTIME_SESSION_PROJECT_NETWORK_ALIAS,
} from "../../../runtime/runtime-service/application/project-runtime-session-network-metadata";
import type { RuntimeSessionNetworkManager } from "../../../runtime/runtime-service/application/runtime-session-network-manager";
import type { WorkspaceManager } from "../../../runtime/runtime-service/application/workspace-manager";
import { DockerAiContainerLauncher } from "../../../runtime/runtime-service/infra/docker-ai-container-launcher";
import { DevcontainerCliLauncher } from "../../../runtime/runtime-service/infra/devcontainer-cli-launcher";
import { GitCliCloneService } from "../../../runtime/runtime-service/infra/git-cli-clone-service";
import { LocalDockerRuntimeSessionNetworkManager } from "../../../runtime/runtime-service/infra/local-docker-runtime-session-network-manager";
import { LocalWorkspaceManager } from "../../../runtime/runtime-service/infra/local-workspace-manager";
import { LocalDevcontainerPortForwardManager } from "../../../runtime/runtime-service/infra/local-devcontainer-port-forward-manager";
import { LocalDevcontainerMcpHostManager } from "../../../runtime/runtime-service/infra/local-devcontainer-mcp-host-manager";
import { createProjectRuntimeSessionExecutionTarget } from "../../../runtime/runtime-service/domain/project-runtime-session-execution-target";
import { logWork } from "../application/work-logger";

const execFileAsync = promisify(execFile);

const ENV_PLACEHOLDER_RE = /^\{env:([^}]+)\}$/u;

function extractReferencedEnvVarNames(
  mcpServers: OpenCodeMcpServers | null | undefined,
): string[] {
  if (!mcpServers) return [];

  const names: string[] = [];

  for (const serverConfig of Object.values(mcpServers)) {
    if (!("type" in serverConfig) || serverConfig.type !== "local") continue;
    if (!serverConfig.environment) continue;

    for (const envValue of Object.values(serverConfig.environment)) {
      const varName = ENV_PLACEHOLDER_RE.exec(envValue)?.[1];
      if (varName) names.push(varName);
    }
  }

  return names;
}

async function getDevcontainerEnv(
  containerId: string,
  varNames: string[],
): Promise<Record<string, string>> {
  if (varNames.length === 0) return {};

  const { stdout } = await execFileAsync("docker", [
    "exec",
    containerId,
    "env",
  ]);
  const wanted = new Set(varNames);
  const result: Record<string, string> = {};

  for (const line of stdout.split("\n")) {
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx);
    if (wanted.has(key)) result[key] = line.slice(eqIdx + 1);
  }

  return result;
}

async function inspectContainerHealthStatus(
  containerId: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      containerId,
    ]);
    return stdout.trim() || "unknown";
  } catch (error) {
    return `unreachable:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function getContainerNetworks(containerId: string): Promise<string[]> {
  const { stdout } = await execFileAsync("docker", [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    containerId,
  ]);
  const networks = JSON.parse(stdout.trim()) as Record<string, unknown> | null;
  return networks ? Object.keys(networks) : [];
}

const SYSTEM_NETWORKS = new Set(["bridge", "host", "none"]);

export type LocalProjectRuntimeEnvironment = StepExecutionRuntimeEnvironment;

export type LocalProjectRuntimeEnvironmentOrchestrator =
  StepExecutionRuntimeEnvironmentOrchestrator;

export class DefaultLocalProjectRuntimeEnvironmentOrchestrator implements LocalProjectRuntimeEnvironmentOrchestrator {
  constructor(
    private readonly deps: {
      workspaceManager: WorkspaceManager;
      gitCloneService: GitCloneService;
      devcontainerLauncher: DevcontainerLauncher;
      aiContainerLauncher: AiContainerLauncher;
      runtimeSessionNetworkManager: RuntimeSessionNetworkManager;
      portForwardManager: LocalDevcontainerPortForwardManager;
      mcpHostManager: LocalDevcontainerMcpHostManager;
    } = {
      workspaceManager: new LocalWorkspaceManager(),
      gitCloneService: new GitCliCloneService(),
      devcontainerLauncher: new DevcontainerCliLauncher(),
      aiContainerLauncher: new DockerAiContainerLauncher(),
      runtimeSessionNetworkManager:
        new LocalDockerRuntimeSessionNetworkManager(),
      portForwardManager: new LocalDevcontainerPortForwardManager(),
      mcpHostManager: new LocalDevcontainerMcpHostManager(),
    },
  ) {}

  async launch(input: {
    sessionId: UuidV7;
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    gitUrl: string;
    requestedBranch?: string | null | undefined;
    opencodeMcpJson?: OpenCodeMcpServers | null | undefined;
    opencodePluginJson?: OpenCodePlugins | null | undefined;
    agentPromptText: string;
    currentExecutionInfo: {
      stepExecutionId: string;
      resultSchemaJson: Record<string, unknown> | null;
    };
  }): Promise<LocalProjectRuntimeEnvironment> {
    let workspacePath: string | null = null;
    let devcontainerId: string | null = null;
    let aiContainerId: string | null = null;
    let networkName: string | null = null;
    // portForwardExecutionTarget captured for cleanup
    let mcpHostExecutionTarget: ReturnType<typeof createProjectRuntimeSessionExecutionTarget> | null = null;
    let portForwardExecutionTarget: ReturnType<typeof createProjectRuntimeSessionExecutionTarget> | null = null;

    try {
      logWork("runtime", "Creating local runtime environment", {
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
        gitUrl: input.gitUrl,
        requestedBranch: input.requestedBranch ?? null,
      });

      const workspace = await this.deps.workspaceManager.createWorkspace({
        sessionId: input.sessionId,
      });
      workspacePath = workspace.workspacePath;
      logWork("runtime", "Workspace created", {
        sessionId: input.sessionId,
        workspacePath,
      });

      const cloneResult = await this.deps.gitCloneService.cloneRepository({
        gitUrl: input.gitUrl,
        workspacePath,
        requestedBranch: input.requestedBranch ?? null,
      });
      logWork("runtime", "Repository cloned into workspace", {
        sessionId: input.sessionId,
        workspacePath,
        resolvedBranch: cloneResult.resolvedBranch,
      });

      const currentExecutionInfoPath = await writeCurrentExecutionInfoFile(
        workspacePath,
        input.currentExecutionInfo,
      );
      logWork("runtime", "Current execution metadata written", {
        sessionId: input.sessionId,
        workspacePath,
        currentExecutionInfoPath,
        stepExecutionId: input.currentExecutionInfo.stepExecutionId,
      });

      const devcontainerConfigPath =
        await this.deps.devcontainerLauncher.resolveConfigPath({
          workspacePath,
        });
      logWork("runtime", "Resolved devcontainer config", {
        sessionId: input.sessionId,
        devcontainerConfigPath,
      });

      // Step 1: Launch devcontainer
      const devcontainerResult = await this.deps.devcontainerLauncher.launch({
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
        workspacePath,
        devcontainerConfigPath,
      });
      devcontainerId = devcontainerResult.containerId;
      logWork("runtime", "Devcontainer launched", {
        sessionId: input.sessionId,
        devcontainerId,
      });

      // Step 2: Start MCP host in devcontainer — must happen before AI container launch
      // so that the MCP server URL is available when we write opencode.json.
      //
      // Build the execution target for the devcontainer (agentContainerId not yet known).
      mcpHostExecutionTarget = createProjectRuntimeSessionExecutionTarget({
        environmentRole: "project",
        runnerAssignment: "local:devcontainer",
        environmentRef: "local:session",
        metadata: {
          localExecution: {
            containerId: devcontainerId,
            workspacePath,
            devcontainerConfigPath,
            // agentContainerId intentionally absent — MCP host only runs in devcontainer
          },
        },
      });

      // Resolve which plugins need to be forwarded to the host.
      // User/npm plugin entries are NOT sent to the AI container; their tools come back via MCP.
      const userPlugins: OpenCodePlugins = input.opencodePluginJson ?? [];

      let mcpHostPort: number | null = null;
      let userToolsMcpUrl: string | undefined;

      if (userPlugins.length > 0) {
        try {
          mcpHostPort = await this.deps.mcpHostManager.ensure(
            mcpHostExecutionTarget,
            userPlugins,
          );
          userToolsMcpUrl = `http://devcontainer:${mcpHostPort}/mcp`;
          logWork("runtime", "MCP host started in devcontainer", {
            sessionId: input.sessionId,
            mcpHostPort,
            userToolsMcpUrl,
          });
        } catch (error) {
          // Degrade gracefully: log the failure but don't abort the session.
          // The step will proceed without user-defined tools.
          logWork("runtime", "MCP host failed to start — proceeding without user tools", {
            sessionId: input.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        logWork("runtime", "No user plugins — skipping MCP host", {
          sessionId: input.sessionId,
        });
      }

      // Step 3: Build OpenCode context with the MCP host URL (if available).
      // User/npm plugins are NOT forwarded to the AI container's config.plugin[].
      // Only the boboddy.js plugin (embedded) remains in .opencode/plugins/.
      const finalOpencodeConfig = await buildOpencodeContext({
        workspacePath,
        stepMcpServers: input.opencodeMcpJson,
        // userPlugins are intentionally omitted here — they go through the MCP host
        stepPlugins: null,
        agentPromptText: input.agentPromptText,
        userToolsMcpUrl,
      });
      logWork("runtime", "OpenCode context built", {
        sessionId: input.sessionId,
        workspacePath,
        userToolsMcpUrl,
      });

      const varNames = extractReferencedEnvVarNames(
        finalOpencodeConfig.mcp as OpenCodeMcpServers | null | undefined,
      );
      const devcontainerEnv = await getDevcontainerEnv(
        devcontainerId,
        varNames,
      );
      const extraEnv: Record<string, string> = {};
      for (const varName of varNames) {
        const value = process.env[varName] ?? devcontainerEnv[varName];
        if (value !== undefined) extraEnv[varName] = value;
      }

      const devcontainerNetworks = await getContainerNetworks(devcontainerId);
      const composeNetworks = devcontainerNetworks.filter(
        (n) => !SYSTEM_NETWORKS.has(n),
      );

      // Step 4: Launch AI container (now that opencode.json references the remote MCP server)
      const aiContainerResult = await this.deps.aiContainerLauncher.launch({
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
        workspacePath,
        extraEnv,
        additionalNetworks: composeNetworks,
      });
      aiContainerId = aiContainerResult.containerId;
      logWork("runtime", "AI container launched", {
        sessionId: input.sessionId,
        aiContainerId,
        aiBaseUrl: aiContainerResult.baseUrl,
        aiImage: aiContainerResult.image,
      });

      const network =
        await this.deps.runtimeSessionNetworkManager.createNetwork(
          input.sessionId,
        );
      networkName = network.networkName;
      logWork("runtime", "Runtime network created", {
        sessionId: input.sessionId,
        networkName,
      });

      await this.deps.runtimeSessionNetworkManager.attachContainer({
        networkName,
        containerId: devcontainerId,
        alias: PROJECT_RUNTIME_SESSION_PROJECT_NETWORK_ALIAS,
      });
      logWork("runtime", "Attached project container to runtime network", {
        sessionId: input.sessionId,
        networkName,
        containerId: devcontainerId,
        alias: PROJECT_RUNTIME_SESSION_PROJECT_NETWORK_ALIAS,
      });
      await this.deps.runtimeSessionNetworkManager.attachContainer({
        networkName,
        containerId: aiContainerId,
        alias: PROJECT_RUNTIME_SESSION_AGENT_NETWORK_ALIAS,
      });
      logWork("runtime", "Attached agent container to runtime network", {
        sessionId: input.sessionId,
        networkName,
        containerId: aiContainerId,
        alias: PROJECT_RUNTIME_SESSION_AGENT_NETWORK_ALIAS,
      });

      portForwardExecutionTarget =
        createProjectRuntimeSessionExecutionTarget({
          environmentRole: "project",
          runnerAssignment: "local:devcontainer",
          environmentRef: "local:session",
          metadata: {
            localExecution: {
              containerId: devcontainerId,
              agentContainerId: aiContainerId,
              workspacePath,
              devcontainerConfigPath,
            },
          },
        });
      await this.deps.portForwardManager.ensureDefaultAccessPoints({
        workspacePath,
        devcontainerConfigPath,
        executionTarget: portForwardExecutionTarget,
      });
      logWork("runtime", "Port forward proxies ready", {
        sessionId: input.sessionId,
        workspacePath,
        devcontainerConfigPath,
      });

      logWork("runtime", "Local runtime environment ready", {
        sessionId: input.sessionId,
        workspacePath,
        resolvedBranch: cloneResult.resolvedBranch,
        devcontainerConfigPath,
        devcontainerId,
        aiContainerId,
        aiBaseUrl: aiContainerResult.baseUrl,
        aiImage: aiContainerResult.image,
        networkName,
      });

      const checkableDevcontainerId = devcontainerId;
      const checkableAiContainerId = aiContainerId;
      if (!checkableDevcontainerId || !checkableAiContainerId) {
        throw new Error(
          "Runtime containers must be available before health checks can run.",
        );
      }

      const capturedMcpHostExecutionTarget = mcpHostExecutionTarget;
      const capturedPortForwardExecutionTarget = portForwardExecutionTarget;

      return {
        workspacePath,
        opencodeLogDirectory: aiContainerResult.opencodeLogDirectory,
        resolvedBranch: cloneResult.resolvedBranch,
        devcontainerConfigPath,
        devcontainerId,
        aiContainerId,
        aiBaseUrl: aiContainerResult.baseUrl,
        aiImage: aiContainerResult.image,
        networkName,
        checkContainerHealth: async () => ({
          devcontainerStatus: await inspectContainerHealthStatus(
            checkableDevcontainerId,
          ),
          aiContainerStatus: await inspectContainerHealthStatus(
            checkableAiContainerId,
          ),
        }),
        cleanup: async () => {
          await Promise.allSettled([
            capturedPortForwardExecutionTarget
              ? this.deps.portForwardManager.stop(capturedPortForwardExecutionTarget)
              : Promise.resolve(),
            capturedMcpHostExecutionTarget
              ? this.deps.mcpHostManager.stop(capturedMcpHostExecutionTarget)
              : Promise.resolve(),
            cleanupEnvironment({
              workspacePath,
              devcontainerId,
              aiContainerId,
              networkName,
              deps: this.deps,
            }),
          ]);
        },
      };
    } catch (error) {
      logWork("runtime", "Runtime environment launch failed; cleaning up", {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await Promise.allSettled([
        mcpHostExecutionTarget
          ? this.deps.mcpHostManager.stop(mcpHostExecutionTarget)
          : Promise.resolve(),
        cleanupEnvironment({
          workspacePath,
          devcontainerId,
          aiContainerId,
          networkName,
          deps: this.deps,
        }),
      ]);
      throw error;
    }
  }
}

async function cleanupEnvironment(input: {
  workspacePath: string | null;
  devcontainerId: string | null;
  aiContainerId: string | null;
  networkName: string | null;
  deps: {
    workspaceManager: WorkspaceManager;
    devcontainerLauncher: DevcontainerLauncher;
    aiContainerLauncher: AiContainerLauncher;
    runtimeSessionNetworkManager: RuntimeSessionNetworkManager;
  };
}) {
  logWork("runtime", "Cleaning up local runtime environment", {
    workspacePath: input.workspacePath,
    devcontainerId: input.devcontainerId,
    aiContainerId: input.aiContainerId,
    networkName: input.networkName,
  });

  await Promise.allSettled([
    input.networkName
      ? input.deps.runtimeSessionNetworkManager.removeNetwork(input.networkName)
      : Promise.resolve(),
    input.devcontainerId
      ? input.deps.devcontainerLauncher.stop(input.devcontainerId)
      : Promise.resolve(),
    input.aiContainerId
      ? input.deps.aiContainerLauncher.stop(input.aiContainerId)
      : Promise.resolve(),
    input.workspacePath
      ? input.deps.workspaceManager.removeWorkspace(input.workspacePath)
      : Promise.resolve(),
  ]);

  logWork("runtime", "Local runtime environment cleanup complete", {
    workspacePath: input.workspacePath,
    devcontainerId: input.devcontainerId,
    aiContainerId: input.aiContainerId,
    networkName: input.networkName,
  });
}
