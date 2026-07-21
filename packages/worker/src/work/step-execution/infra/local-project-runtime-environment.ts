import path from "node:path";
import os from "node:os";
import { buildOpencodeContext } from "@boboddy/opencode-plugin";
import {
  removeFindingsSubmissionFile,
  writeCurrentExecutionInfoFile,
} from "../application/process-project-work-findings";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { OpenCodePlugins } from "../../../common/contracts/opencode-plugin";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  StepExecutionRuntimeEnvironment,
  StepExecutionRuntimeEnvironmentOrchestrator,
} from "../contracts/process-project-work-types";
import type { DevcontainerLauncher } from "../../../runtime/runtime-service/application/devcontainer-launcher";
import type { GitCloneService } from "../../../runtime/runtime-service/application/git-clone-service";
import type { GitCommitPushService } from "../../../runtime/runtime-service/application/git-commit-push-service";
import type { SubmoduleService } from "../../../runtime/runtime-service/application/submodule-service";
import type { WorkspaceManager } from "../../../runtime/runtime-service/application/workspace-manager";
import { DevcontainerCliLauncher } from "../../../runtime/runtime-service/infra/devcontainer-cli-launcher";
import { GitCliCloneService } from "../../../runtime/runtime-service/infra/git-cli-clone-service";
import { GitCliCommitPushService } from "../../../runtime/runtime-service/infra/git-cli-commit-push-service";
import { GitCliSubmoduleService } from "../../../runtime/runtime-service/infra/git-cli-submodule-service";
import { LocalWorkspaceManager } from "../../../runtime/runtime-service/infra/local-workspace-manager";
import { loadProjectConfig } from "../../../project/project-config/infra/fs-project-config-repo";
import { resolveConfiguredBaseWorkBranch } from "../application/process-claimed-step-execution-helpers";
import { OpencodeRuntimePayloadProvisioner } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { DevcontainerOpencodeBootstrap } from "../../../runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import { logWork } from "../application/work-logger";
import { noopLogger, type Logger } from "../../../lib/logger";
import { noopReporter, type WorkReporter } from "../contracts/work-reporter";
import type { ProviderAccessResolver } from "../contracts/agent-runtime/provider-access-resolver";
import type { RuntimeConfigMaterializer } from "../contracts/agent-runtime/runtime-config-materializer";
import { DirectProviderAccessResolver } from "./provider-access/direct-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "./provider-access/session-runtime-config-materializer";
import {
  cleanupEnvironment,
  inspectContainerHealthStatus,
  patchDevcontainerEnv,
  resolveDevcontainerWorkspaceFolder,
} from "./local-project-runtime-environment-helpers";
import {
  buildCommitAndPushWorkBranch,
  prepareWorkBranch,
} from "./work-branch-manager";

export type LocalProjectRuntimeEnvironment = StepExecutionRuntimeEnvironment;

export type LocalProjectRuntimeEnvironmentOrchestrator =
  StepExecutionRuntimeEnvironmentOrchestrator;

/**
 * Single-container launch orchestrator.
 *
 * The runtime is exactly one container: the user's devcontainer. OpenCode runs
 * INSIDE it (Phase 3 bootstrap), so there is no separate AI container, session
 * network, cross-container port-forward, or env read-back/inject step. User
 * `.opencode/tools` files and `plugin[]` entries are trusted and loaded directly
 * by the in-container OpenCode, so there is no MCP-host indirection.
 */
export class DefaultLocalProjectRuntimeEnvironmentOrchestrator implements LocalProjectRuntimeEnvironmentOrchestrator {
  constructor(
    private readonly logger: Logger = noopLogger,
    private readonly localEnvVars: Record<string, string> = {},
    private readonly deps: {
      workspaceManager: WorkspaceManager;
      gitCloneService: GitCloneService;
      gitCommitPushService: GitCommitPushService;
      submoduleService: SubmoduleService;
      devcontainerLauncher: DevcontainerLauncher;
      // Boboddy-managed OpenCode runtime payload + in-devcontainer bootstrap +
      // provider-access resolution/materialization.
      payloadProvisioner: OpencodeRuntimePayloadProvisioner;
      opencodeBootstrap: DevcontainerOpencodeBootstrap;
      providerAccessResolver: ProviderAccessResolver;
      runtimeConfigMaterializer: RuntimeConfigMaterializer;
    } = {
      workspaceManager: new LocalWorkspaceManager(),
      gitCloneService: new GitCliCloneService(logger),
      gitCommitPushService: new GitCliCommitPushService(logger),
      submoduleService: new GitCliSubmoduleService(logger),
      devcontainerLauncher: new DevcontainerCliLauncher(),
      payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
      opencodeBootstrap: new DevcontainerOpencodeBootstrap(),
      providerAccessResolver: new DirectProviderAccessResolver({ logger }),
      runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
        outputBaseDir: path.join(os.tmpdir(), "boboddy-provider-config"),
      }),
    },
  ) {}

  async launch(input: {
    sessionId: UuidV7;
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    gitUrl: string;
    /**
     * The branch a later step must be created off of, handed down by the server
     * (the predecessor step's work branch). Takes precedence over any repo-local
     * configured base branch. Null for the first step.
     */
    baseWorkBranch?: string | null | undefined;
    stepKey?: string | undefined;
    opencodeMcpJson?: OpenCodeMcpServers | null | undefined;
    opencodePluginJson?: OpenCodePlugins | null | undefined;
    currentExecutionInfo: {
      stepExecutionId: string;
      resultSchemaJson: Record<string, unknown> | null;
    };
    reporter?: WorkReporter | undefined;
    stepExecutionId?: string | undefined;
    /**
     * Optional sink for individual devcontainer launch log lines. Wired to the
     * step's log shipper so the CLI's real subprocess output (npm/pip/`init.sh`
     * stderr, submodule clones, etc.) is streamed to the durable feed as it
     * appears, at the CLI's own severity. Separate from `reporter`, which is
     * presentation-only.
     */
    onDevcontainerLogLine?:
      | ((line: string, level: "info" | "warn" | "error") => void)
      | undefined;
  }): Promise<LocalProjectRuntimeEnvironment> {
    const reporter = input.reporter ?? noopReporter;
    const stepExecutionId =
      input.stepExecutionId ?? input.currentExecutionInfo.stepExecutionId;
    let workspacePath: string | null = null;
    let devcontainerId: string | null = null;
    let opencodeStarted = false;

    try {
      logWork("runtime", "Creating local runtime environment", {
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
        gitUrl: input.gitUrl,
        baseWorkBranch: input.baseWorkBranch ?? null,
      });

      // Step 1: Create workspace + clone the repo into it.
      const workspace = await this.deps.workspaceManager.createWorkspace({
        sessionId: input.sessionId,
      });
      workspacePath = workspace.workspacePath;
      logWork("runtime", "Workspace created", {
        sessionId: input.sessionId,
        workspacePath,
      });

      reporter.event({ type: "step:runtime-cloning", stepExecutionId });
      const cloneResult = await this.deps.gitCloneService.cloneRepository({
        gitUrl: input.gitUrl,
        workspacePath,
      });
      logWork("runtime", "Repository cloned into workspace", {
        sessionId: input.sessionId,
        workspacePath,
        resolvedBranch: cloneResult.resolvedBranch,
      });

      // Step 1b: Determine the base and create the work branch off it right
      // after clone. Skipped (fields null) only when there is no step key.
      let workBranch: string | null = null;
      let createdFromBranch: string | null = null;
      if (input.stepKey) {
        // The repo is cloned, so its `.boboddy/boboddy.jsonc` is on disk. Read
        // the optional `branchPrefix` from it; a missing/invalid value falls
        // back to the default `boboddy` prefix inside prepareWorkBranch.
        const projectConfig = await loadProjectConfig(workspacePath);
        // Resolve the base branch this step is created off of. The server-handed
        // baseWorkBranch (predecessor step's work branch) wins for later steps.
        // Otherwise use the repo-local configured base (env over jsonc); null
        // means create off the cloned default branch.
        const baseWorkBranch =
          input.baseWorkBranch ??
          resolveConfiguredBaseWorkBranch({
            localEnvVars: this.localEnvVars,
            configuredBaseWorkBranch: projectConfig?.baseWorkBranch ?? null,
          });
        const prepared = await prepareWorkBranch({
          gitCommitPushService: this.deps.gitCommitPushService,
          workspacePath,
          resolvedBranch: cloneResult.resolvedBranch,
          baseWorkBranch,
          stepKey: input.stepKey,
          stepExecutionId: input.currentExecutionInfo.stepExecutionId,
          branchPrefix: projectConfig?.branchPrefix ?? null,
        });
        workBranch = prepared.workBranch;
        createdFromBranch = prepared.createdFromBranch;
      }

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

      // Remove any findings submission file carried over from the previous
      // step's work branch (this branch was cloned from it). Otherwise the
      // monitor's first poll reads the stale file and fails the step before
      // the agent starts.
      await removeFindingsSubmissionFile(workspacePath);

      // Step 2: Resolve the cloned devcontainer config + its workspace folder.
      const devcontainerConfigPath =
        await this.deps.devcontainerLauncher.resolveConfigPath({
          workspacePath,
        });
      const devcontainerWorkspaceFolder =
        await resolveDevcontainerWorkspaceFolder({
          workspacePath,
          devcontainerConfigPath,
        });
      // The agent-facing workspace folder inside the devcontainer: the declared
      // workspaceFolder, or the CLI convention /workspaces/<basename>.
      const agentWorkspaceFolder =
        devcontainerWorkspaceFolder ??
        `/workspaces/${path.basename(workspacePath)}`;
      logWork("runtime", "Resolved devcontainer config", {
        sessionId: input.sessionId,
        devcontainerConfigPath,
        devcontainerWorkspaceFolder,
        agentWorkspaceFolder,
      });

      // Step 3: Patch the cloned devcontainer.json before `up`.
      //   3a. containerEnv from .boboddy/.env (baked in as `-e KEY=VALUE`).
      //   3b. Boboddy-managed OpenCode runtime payload + (optional) provider
      //       config mounts, plus the host port OpenCode is exposed on. Both use
      //       the same comment-safe JSON patch mechanism. The agent HOME is NOT
      //       mounted — it lives on the container's overlay fs and is seeded
      //       post-launch (see prepareAgentHome below).
      if (Object.keys(this.localEnvVars).length > 0) {
        await patchDevcontainerEnv(
          workspacePath,
          devcontainerConfigPath,
          this.localEnvVars,
        );
        logWork("runtime", "Patched devcontainer.json with .boboddy/.env vars", {
          sessionId: input.sessionId,
          devcontainerConfigPath,
          varCount: Object.keys(this.localEnvVars).length,
          varNames: Object.keys(this.localEnvVars),
        });
      } else {
        logWork("runtime", "No .boboddy/.env vars to inject into devcontainer", {
          sessionId: input.sessionId,
        });
      }

      const payload = await this.deps.payloadProvisioner.ensure();
      logWork("runtime", "OpenCode runtime payload ready", {
        sessionId: input.sessionId,
        version: payload.version,
        hostPayloadDir: payload.hostPayloadDir,
        containerPayloadDir: payload.containerPayloadDir,
      });

      const providerAccess = await this.deps.providerAccessResolver.resolve({
        projectId: input.projectId,
        sessionId: input.sessionId,
        requestedByUserId: input.requestedByUserId,
      });
      const materialized = await this.deps.runtimeConfigMaterializer.materialize(
        {
          runtimeContainerId: input.sessionId,
          workspaceFolder: agentWorkspaceFolder,
          providerAccess,
        },
      );
      // Mount the materialized provider config dir READ-ONLY only when the
      // chosen source produced config files (never broad host credential dirs).
      const providerConfigDir =
        materialized.configFiles && materialized.configFiles.length > 0
          ? path.dirname(materialized.configFiles[0] ?? "")
          : undefined;
      logWork("runtime", "Provider access resolved and materialized", {
        sessionId: input.sessionId,
        providerMode: providerAccess.mode,
        providerEnvKeys: Object.keys(materialized.env).sort(),
        hasProviderConfigDir: Boolean(providerConfigDir),
      });

      const mountPlan = await this.deps.opencodeBootstrap.planMounts({
        payload,
        providerConfigDir,
      });
      await this.deps.opencodeBootstrap.patchConfig({
        workspacePath,
        devcontainerConfigPath,
        mounts: mountPlan.mounts,
        hostPort: mountPlan.hostPort,
      });
      logWork("runtime", "Patched devcontainer.json with OpenCode runtime mounts", {
        sessionId: input.sessionId,
        mountTargets: mountPlan.mounts.map((m) => m.target),
        hostPort: mountPlan.hostPort,
      });

      // Step 4: Launch the devcontainer. Stream the CLI's lifecycle progress
      // (notably the long-running postCreateCommand) to the reporter so the
      // user sees real activity instead of a seemingly-frozen spinner.
      reporter.event({ type: "step:runtime-container-starting", stepExecutionId });
      const devcontainerResult = await this.deps.devcontainerLauncher.launch({
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
        workspacePath,
        devcontainerConfigPath,
        onProgress: ({ kind, phase, level }) => {
          // Presentation: rolling live window in the terminal.
          reporter.event({
            type: "step:runtime-container-progress",
            stepExecutionId,
            kind,
            phase,
            level,
          });
          // Durable feed: ship each line to the server as it appears, at the
          // CLI's own severity so errors survive the ship-level filter.
          input.onDevcontainerLogLine?.(phase, level);
        },
      });
      devcontainerId = devcontainerResult.containerId;
      logWork("runtime", "Devcontainer launched", {
        sessionId: input.sessionId,
        devcontainerId,
      });

      // Step 4b: Seed the agent HOME NOW that the container is running. The
      // agent HOME lives on the container's native overlay filesystem (not a
      // host bind mount), so it cannot be pre-populated on the host — instead
      // the user's host global opencode config (precedence #2) and provider
      // auth are piped into the running container. The project repo is untouched.
      const { hostConfigPath, hostAuthPath } =
        await this.deps.opencodeBootstrap.prepareAgentHome({
          containerId: devcontainerId,
        });
      logWork("runtime", "Agent HOME global config prepared", {
        sessionId: input.sessionId,
        hostConfigPath: hostConfigPath ?? "(none — no host global config found)",
        hostAuthPath: hostAuthPath ?? "(none — no host auth.json found)",
      });

      // Step 5: Build the OpenCode context. User `.opencode/tools` files and
      // npm `plugin[]` entries are trusted in the single-container model: they
      // load directly in the in-container OpenCode process. The in-container
      // OpenCode also inherits the devcontainer's own environment, so there is
      // no cross-container env read-back/injection.
      //
      // Unlike the old approach, we do NOT write the project's
      // `.opencode/opencode.json` — the project repo is left untouched.
      // Instead, buildOpencodeContext returns a JSON string carrying Boboddy's
      // required additions (permission baseline, step MCPs, AGENT_DEFAULT_MODEL)
      // that is passed to OpenCode as OPENCODE_CONFIG_CONTENT (precedence #6).
      // The user's home config (model, providers) was seeded into the
      // container's overlay agent HOME post-launch by prepareAgentHome and is
      // loaded at #2.
      const { opencodeConfigContent } = await buildOpencodeContext({
        workspacePath,
        stepMcpServers: input.opencodeMcpJson,
        stepPlugins: input.opencodePluginJson,
        // No agent system prompt: the step prompt is delivered as the user
        // message, so opencode keeps its default build agent prompt.
      });
      logWork("runtime", "OpenCode context built", {
        sessionId: input.sessionId,
        workspacePath,
        npmPluginCount: input.opencodePluginJson?.length ?? 0,
      });

      // Step 6: Start OpenCode INSIDE the devcontainer from the mounted payload,
      // by absolute path, with the dedicated session HOME and resolved workspace
      // cwd. Health is awaited and the host-facing base URL is returned.
      reporter.event({ type: "step:runtime-ai-starting", stepExecutionId });
      const opencodeStart = await this.deps.opencodeBootstrap.start({
        containerId: devcontainerId,
        workspaceFolder: agentWorkspaceFolder,
        hostPort: mountPlan.hostPort,
        launchWrapperPath: payload.containerLaunchWrapperPath,
        providerEnv: materialized.env,
        opencodeConfigContent,
      });
      opencodeStarted = true;
      logWork("runtime", "In-devcontainer OpenCode started", {
        sessionId: input.sessionId,
        devcontainerId,
        agentBaseUrl: opencodeStart.agentBaseUrl,
        agentWorkspaceFolder,
      });

      logWork("runtime", "Local runtime environment ready", {
        sessionId: input.sessionId,
        workspacePath,
        resolvedBranch: cloneResult.resolvedBranch,
        devcontainerConfigPath,
        devcontainerId,
        agentBaseUrl: opencodeStart.agentBaseUrl,
        opencodeRuntimeVersion: payload.version,
      });

      const checkableDevcontainerId = devcontainerId;
      const capturedDevcontainerId = devcontainerId;
      const capturedWorkspacePath = workspacePath;
      const capturedWorkBranch = workBranch;

      return {
        workspacePath,
        // OpenCode runs inside the devcontainer, so the agent-facing workspace
        // folder is the devcontainer's resolved workspace folder.
        workspaceFolder: agentWorkspaceFolder,
        opencodeLogDirectory: opencodeStart.agentLogDirectory,
        resolvedBranch: cloneResult.resolvedBranch,
        workBranch,
        createdFromBranch,
        commitAndPushWorkBranch: capturedWorkBranch
          ? buildCommitAndPushWorkBranch({
              gitCommitPushService: this.deps.gitCommitPushService,
              submoduleService: this.deps.submoduleService,
              workspacePath: capturedWorkspacePath,
              workBranch: capturedWorkBranch,
              stepExecutionId: input.currentExecutionInfo.stepExecutionId,
            })
          : undefined,
        devcontainerConfigPath,
        // Single runtime container id: the devcontainer, which also hosts
        // OpenCode.
        runtimeContainerId: devcontainerId,
        agentBaseUrl: opencodeStart.agentBaseUrl,
        // No AI image is used; surface the pinned OpenCode runtime version.
        aiImage: `opencode-runtime@${payload.version}`,
        networkName: "",
        // Provider token(s) injected into the container (Path B). The caller
        // registers these with the log masker before the in-container tail is
        // attached so they can never surface in the shipped feed.
        secretValues: Object.values(materialized.env),
        checkContainerHealth: async () => ({
          runtimeContainerStatus: await inspectContainerHealthStatus(
            checkableDevcontainerId,
          ),
        }),
        cleanup: async () => {
          // The agent HOME lives on the container's overlay fs and dies with
          // the container, so no host-dir cleanup is needed — only stop the
          // in-container OpenCode and tear down the container + workspace.
          await Promise.allSettled([
            this.deps.opencodeBootstrap.stop(capturedDevcontainerId),
            cleanupEnvironment({
              workspacePath: capturedWorkspacePath,
              devcontainerId: capturedDevcontainerId,
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
      // No host agent-HOME cleanup: it lives on the container's overlay fs and
      // dies with the container.
      await Promise.allSettled([
        opencodeStarted && devcontainerId
          ? this.deps.opencodeBootstrap.stop(devcontainerId)
          : Promise.resolve(),
        cleanupEnvironment({
          workspacePath,
          devcontainerId,
          deps: this.deps,
        }),
      ]);
      throw error;
    }
  }
}
