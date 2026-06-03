import { buildOpencodeContext } from "@boboddy/opencode-plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeCurrentExecutionInfoFile } from "../application/process-project-work-findings";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
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
    } = {
      workspaceManager: new LocalWorkspaceManager(),
      gitCloneService: new GitCliCloneService(),
      devcontainerLauncher: new DevcontainerCliLauncher(),
      aiContainerLauncher: new DockerAiContainerLauncher(),
      runtimeSessionNetworkManager:
        new LocalDockerRuntimeSessionNetworkManager(),
      portForwardManager: new LocalDevcontainerPortForwardManager(),
    },
  ) {}

  async launch(input: {
    sessionId: UuidV7;
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    gitUrl: string;
    requestedBranch?: string | null | undefined;
    opencodeMcpJson?: OpenCodeMcpServers | null | undefined;
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

      await buildOpencodeContext({
        workspacePath,
        stepMcpServers: input.opencodeMcpJson,
        agentPromptText: input.agentPromptText,
      });
      logWork("runtime", "OpenCode context built", {
        sessionId: input.sessionId,
        workspacePath,
      });

      await writeCurrentExecutionInfoFile(
        workspacePath,
        input.currentExecutionInfo,
      );
      logWork("runtime", "Current execution metadata written", {
        sessionId: input.sessionId,
        workspacePath,
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

      const varNames = extractReferencedEnvVarNames(input.opencodeMcpJson);
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

      const portForwardExecutionTarget =
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
            this.deps.portForwardManager.stop(portForwardExecutionTarget),
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
      await cleanupEnvironment({
        workspacePath,
        devcontainerId,
        aiContainerId,
        networkName,
        deps: this.deps,
      });
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
