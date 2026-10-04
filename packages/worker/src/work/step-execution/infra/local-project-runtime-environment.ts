import path from "node:path";
import type { RepoConfig } from "@boboddy/sdk/repo-config";
import {
  removeFindingsSubmissionFile,
  writeCurrentExecutionInfoFile,
} from "../application/process-project-work-findings";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { OpenCodePlugins } from "../../../common/contracts/opencode-plugin";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  AgentRuntime,
  ProjectWorkLogger,
  StepExecutionRuntimeEnvironment,
  StepExecutionRuntimeEnvironmentOrchestrator,
} from "../contracts/process-project-work-types";
import { startStopwatch } from "../../../lib/elapsed";
import { logWork } from "../application/work-logger";
import { noopLogger, type Logger } from "@boboddy/observability/logging/host";
import { noopReporter, type WorkReporter } from "../contracts/work-reporter";
import {
  cleanupEnvironment,
  inspectContainerHealthStatus,
  patchDevcontainerEnv,
  resolveDevcontainerConfig,
  resolveDevcontainerWorkspaceFolder,
} from "./local-project-runtime-environment-helpers";
import {
  MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS,
  resolveManagedRuntime,
} from "../../../runtime/runtime-service/domain/managed-runtimes";
import { writeManagedRuntimeConfig } from "../../../runtime/runtime-service/infra/managed-runtime-config";
import { setUpLaunchBranches } from "./launch-branch-setup";
import { buildCommitAndPushWorkBranch } from "./work-branch-manager";
import {
  prepareAgentLaunch,
  startAgentInContainer,
} from "./local-project-agent-launch";
import {
  buildLocalProjectRuntimeDeps,
  type LocalProjectRuntimeEnvironmentDeps,
} from "./local-project-runtime-environment-deps";

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
    private readonly deps: LocalProjectRuntimeEnvironmentDeps = buildLocalProjectRuntimeDeps(
      logger,
      localEnvVars,
    ),
  ) {}

  async launch(input: {
    /** See `StepExecutionRuntimeEnvironmentOrchestrator.launch`'s `startAgent`. */
    startAgent: boolean;
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
    /**
     * The CLI's resolved (or explicitly overridden) current local branch at
     * `boboddy work` invocation. Checked out immediately after clone for the
     * FIRST step of a pipeline attempt only (when `baseWorkBranch` above is
     * absent) — takes precedence over the repo-local configured base branch,
     * which in turn falls back to the cloned default branch. Ignored entirely
     * when `baseWorkBranch` is present (a later step).
     */
    sourceBranch?: string | null | undefined;
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
      ((line: string, level: "info" | "warn" | "error") => void) | undefined;
    /**
     * Opt-in hook that bakes a fake AI provider into the launch-time inline
     * config, pointed at `baseUrl`, instead of PATCHing `/config` on an
     * already-running agent (proven to have zero live effect — see #109).
     * Set by `run --dry-run` (#109/#110) and, since #120, by real step
     * execution for steps that declare `healthChecks` — a step declaring none
     * never sets this field, so it launches unaffected exactly as before.
     */
    fakeAiProviderOverride?: { baseUrl: string } | undefined;
    /** See `StepExecutionRuntimeEnvironmentOrchestrator.launch`'s `stepEnv`. */
    stepEnv?: Readonly<Record<string, string>> | undefined;
    /** See `StepExecutionRuntimeEnvironmentOrchestrator.launch`'s `devcontainerConfigPath`. */
    devcontainerConfigPath?: string | null | undefined;
    /** See `StepExecutionRuntimeEnvironmentOrchestrator.launch`'s `managedRuntime`. */
    managedRuntime?: string | null | undefined;
    /** See `StepExecutionRuntimeEnvironmentOrchestrator.launch`'s `repo`. */
    repo: RepoConfig;
    /** See `StepExecutionRuntimeEnvironmentOrchestrator.launch`'s `stepInputJson`. */
    stepInputJson?: unknown;
    /**
     * Receives the clone and work-branch timing lines at info level. Wired to
     * the step's tee logger so they ship in the durable log feed.
     */
    logger?: ProjectWorkLogger | undefined;
  }): Promise<LocalProjectRuntimeEnvironment> {
    if (input.repo.mode === "none") {
      throw new Error(
        'A workspace step cannot use repo mode "none": it clones the repository ' +
          "to read its devcontainer config. Use readOnly or readWrite.",
      );
    }
    const managedRuntime = input.managedRuntime
      ? resolveManagedRuntime(input.managedRuntime)
      : null;
    const reporter = input.reporter ?? noopReporter;
    const stepExecutionId =
      input.stepExecutionId ?? input.currentExecutionInfo.stepExecutionId;
    let workspacePath: string | null = null;
    let devcontainerId: string | null = null;
    let agent: AgentRuntime | null = null;

    try {
      logWork("runtime", "Creating local runtime environment", {
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
        gitUrl: input.gitUrl,
        baseWorkBranch: input.baseWorkBranch ?? null,
        sourceBranch: input.sourceBranch ?? null,
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
      const elapsedClone = startStopwatch();
      const cloneResult = await this.deps.gitCloneService.cloneRepository({
        gitUrl: input.gitUrl,
        workspacePath,
        logger: input.logger,
      });
      input.logger?.log("runtime", `repository cloned in ${elapsedClone()}`);
      logWork("runtime", "Repository cloned into workspace", {
        sessionId: input.sessionId,
        workspacePath,
        resolvedBranch: cloneResult.resolvedBranch,
      });

      // Step 1b: Check out the base and, for a readWrite step, create the work
      // branch off it right after clone.
      const { workBranch, createdFromBranch, devcontainerLookupBranch } =
        await setUpLaunchBranches({
          gitCommitPushService: this.deps.gitCommitPushService,
          workspacePath,
          resolvedBranch: cloneResult.resolvedBranch,
          repo: input.repo,
          stepKey: input.stepKey,
          stepExecutionId: input.currentExecutionInfo.stepExecutionId,
          baseWorkBranch: input.baseWorkBranch,
          sourceBranch: input.sourceBranch,
          localEnvVars: this.localEnvVars,
          logger: input.logger,
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

      // Remove any findings submission file carried over from the previous
      // step's work branch (this branch was cloned from it). Otherwise the
      // monitor's first poll reads the stale file and fails the step before
      // the agent starts.
      await removeFindingsSubmissionFile(workspacePath);

      // Step 2: Resolve the devcontainer config + its workspace folder: the
      // cloned repo's, or for a managed runtime one synthesized into the clone.
      const devcontainerConfigPath = managedRuntime
        ? await writeManagedRuntimeConfig({
            workspacePath,
            id: managedRuntime.id,
          })
        : await resolveDevcontainerConfig({
            devcontainerLauncher: this.deps.devcontainerLauncher,
            workspacePath,
            requestedConfigPath: input.devcontainerConfigPath,
            lookupBranch: devcontainerLookupBranch,
          });
      if (managedRuntime) {
        input.logger?.log(
          "runtime",
          `managed runtime ${managedRuntime.id} (${managedRuntime.definition.image})`,
        );
      }
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

      // Step 3a: Patch the cloned devcontainer.json before `up` with the
      // containerEnv from .boboddy/.env (baked in as `-e KEY=VALUE`).
      if (Object.keys(this.localEnvVars).length > 0) {
        await patchDevcontainerEnv(
          workspacePath,
          devcontainerConfigPath,
          this.localEnvVars,
        );
        logWork(
          "runtime",
          "Patched devcontainer.json with .boboddy/.env vars",
          {
            sessionId: input.sessionId,
            devcontainerConfigPath,
            varCount: Object.keys(this.localEnvVars).length,
            varNames: Object.keys(this.localEnvVars),
          },
        );
      } else {
        logWork(
          "runtime",
          "No .boboddy/.env vars to inject into devcontainer",
          {
            sessionId: input.sessionId,
          },
        );
      }

      // Step 3b: For steps that start an agent, ensure the OpenCode runtime
      // payload, materialize provider access, and patch the devcontainer
      // config with the payload mounts, published port and host-gateway
      // runArgs. A step without an agent launches an unmodified devcontainer.
      const plan = input.startAgent
        ? await prepareAgentLaunch({
            deps: this.deps,
            sessionId: input.sessionId,
            projectId: input.projectId,
            requestedByUserId: input.requestedByUserId,
            workspacePath,
            devcontainerConfigPath,
            agentWorkspaceFolder,
          })
        : null;

      // Step 4: Launch the devcontainer. Stream the CLI's lifecycle progress
      // (notably the long-running postCreateCommand) to the reporter so the
      // user sees real activity instead of a seemingly-frozen spinner.
      reporter.event({
        type: "step:runtime-container-starting",
        stepExecutionId,
      });
      const devcontainerResult = await this.deps.devcontainerLauncher.launch({
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
        workspacePath,
        devcontainerConfigPath,
        ...(this.deps.gitCacheDir
          ? { hostEnv: { BOBODDY_GIT_CACHE_DIR: this.deps.gitCacheDir } }
          : {}),
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

      // Step 4b/5/6: With the container running, seed the agent HOME, build
      // the OpenCode context, and start OpenCode inside the devcontainer.
      // Skipped for steps that do not start an agent.
      agent = plan
        ? await startAgentInContainer({
            deps: this.deps,
            plan,
            sessionId: input.sessionId,
            containerId: devcontainerId,
            workspacePath,
            agentWorkspaceFolder,
            stepEnv: input.stepEnv,
            opencodeMcpJson: input.opencodeMcpJson,
            opencodePluginJson: input.opencodePluginJson,
            fakeAiProviderOverride: input.fakeAiProviderOverride,
            reporter,
            stepExecutionId,
          })
        : null;

      logWork("runtime", "Local runtime environment ready", {
        sessionId: input.sessionId,
        workspacePath,
        resolvedBranch: cloneResult.resolvedBranch,
        devcontainerConfigPath,
        devcontainerId,
        agentBaseUrl: agent?.baseUrl ?? null,
        opencodeRuntimeVersion: plan?.payload.version ?? null,
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
        resolvedBranch: cloneResult.resolvedBranch,
        workBranch,
        createdFromBranch,
        commitAndPushWorkBranch:
          capturedWorkBranch && input.repo.mode === "readWrite"
            ? buildCommitAndPushWorkBranch({
                gitCommitPushService: this.deps.gitCommitPushService,
                submoduleService: this.deps.submoduleService,
                workspacePath: capturedWorkspacePath,
                workBranch: capturedWorkBranch,
                stepExecutionId: input.currentExecutionInfo.stepExecutionId,
                message: input.repo.message,
                inputJson: input.stepInputJson,
                onPushFailure: input.repo.onPushFailure,
                extraExcludePaths: [
                  devcontainerConfigPath,
                  ...(managedRuntime
                    ? MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS
                    : []),
                ],
              })
            : undefined,
        devcontainerConfigPath,
        // Single runtime container id: the devcontainer, which also hosts
        // OpenCode.
        runtimeContainerId: devcontainerId,
        agent,
        // No AI image is used; surface the pinned OpenCode runtime version
        // (empty when no agent was started).
        aiImage: plan ? `opencode-runtime@${plan.payload.version}` : "",
        networkName: "",
        // Provider token(s) injected into the container (Path B). The caller
        // registers these with the log masker before the in-container tail is
        // attached so they can never surface in the shipped feed. Empty when
        // no agent was started: no provider env was materialized.
        secretValues: plan ? Object.values(plan.materialized.env) : [],
        checkContainerHealth: async () => ({
          runtimeContainerStatus: await inspectContainerHealthStatus(
            checkableDevcontainerId,
          ),
        }),
        cleanup: async () => {
          // The agent HOME lives on the container's overlay fs and dies with
          // the container, so no host-dir cleanup is needed — only stop the
          // in-container OpenCode (when one was started) and tear down the
          // container + workspace.
          await Promise.allSettled([
            agent
              ? this.deps.opencodeBootstrap.stop(capturedDevcontainerId)
              : Promise.resolve(),
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
        agent && devcontainerId
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
