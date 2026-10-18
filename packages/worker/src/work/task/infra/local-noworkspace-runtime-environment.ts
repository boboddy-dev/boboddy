import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildOpencodeContext } from "@boboddy/opencode-plugin";
import type { RepoConfig } from "@boboddy/sdk/repo-config";
import {
  removeFindingsSubmissionFile,
  writeCurrentExecutionInfoFile,
} from "../application/process-project-work-findings";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../application/resolve-step-env";
import { logWork, logWorkWarn } from "../application/work-logger";
import {
  writePreviousRunFiles,
  type PreviousRunFilesInput,
} from "../application/write-previous-run-files";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  ProjectWorkLogger,
  TaskRuntimeEnvironment,
  TaskRuntimeEnvironmentOrchestrator,
} from "../contracts/process-project-work-types";
import { OpencodeRuntimePayloadProvisioner } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import {
  cleanupSessionHome,
  prepareAgentHomeConfig,
  resolveSessionAgentHomeDir,
} from "../../../runtime/runtime-service/infra/opencode-agent-home";
import {
  loadOpencodeCredentials,
  opencodeCredentialSecrets,
  type OpencodeCredentialLoader,
} from "../../../runtime/runtime-service/infra/opencode-credential-source";
import { LAUNCH_WRAPPER_FILENAME } from "../../../runtime/runtime-service/domain/opencode-runtime-payload";
import {
  HOST_AGENT_SERVE_LOG_FILENAME,
  HostOpencodeBootstrap,
} from "../../../runtime/runtime-service/infra/host-opencode-bootstrap";
import { noopReporter, type WorkReporter } from "../contracts/work-reporter";
import { noopLogger, type Logger } from "@boboddy/observability/logging/host";
import type { ProviderAccessResolver } from "../contracts/agent-runtime/provider-access-resolver";
import type { RuntimeConfigMaterializer } from "../contracts/agent-runtime/runtime-config-materializer";
import { DirectProviderAccessResolver } from "./provider-access/direct-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "./provider-access/session-runtime-config-materializer";
import { buildFakeProviderConfig } from "./fake-ai";
import {
  applyStepMcpEnv,
  planStepMcpServers,
} from "./resolve-launch-mcp-servers";

export type LocalNoWorkspaceRuntimeEnvironmentOrchestrator =
  TaskRuntimeEnvironmentOrchestrator;

/**
 * `no_workspace` launch orchestrator.
 *
 * Runs OpenCode DIRECTLY ON THE HOST against a throwaway temp working
 * directory. There is NO git clone and NO devcontainer: the step runs with only
 * the rendered prompt + provided context. Everything else — step MCP servers,
 * the embedded Boboddy findings plugin, provider credentials,
 * `resultSchemaJson` validation, log/conversation streaming, completion — works
 * exactly as on the `workspace` path, because we reuse the same context builder,
 * execution-info file, provider-access resolution, and payload wrapper.
 *
 * Implements the same {@link TaskRuntimeEnvironmentOrchestrator}
 * contract as the devcontainer orchestrator and returns the same
 * {@link TaskRuntimeEnvironment} shape, with `runtimeContainerId: null`
 * (no container) and `agent.hostLogPath` set so the monitor tails the host log
 * file rather than doing `docker exec`.
 *
 * MCP server refs are resolved the same way as on the workspace path, by
 * discovering the repository's servers in the working directory. That
 * directory is an empty temp dir, so a `no_workspace` step can use inline
 * servers only; a ref always fails before launch.
 */
export class DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator implements LocalNoWorkspaceRuntimeEnvironmentOrchestrator {
  constructor(
    private readonly logger: Logger = noopLogger,
    private readonly deps: {
      payloadProvisioner: OpencodeRuntimePayloadProvisioner;
      providerAccessResolver: ProviderAccessResolver;
      runtimeConfigMaterializer: RuntimeConfigMaterializer;
      hostOpencodeBootstrap: HostOpencodeBootstrap;
      loadCredentials: OpencodeCredentialLoader;
    } = {
      payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
      providerAccessResolver: new DirectProviderAccessResolver({ logger }),
      runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
        outputBaseDir: path.join(os.tmpdir(), "boboddy-provider-config"),
      }),
      hostOpencodeBootstrap: new HostOpencodeBootstrap(),
      loadCredentials: loadOpencodeCredentials,
    },
  ) {}

  async launch(input: {
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s `startAgent`. */
    startAgent: boolean;
    sessionId: UuidV7;
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    gitUrl: string;
    baseWorkBranch?: string | null | undefined;
    /**
     * Unused here: `no_workspace` steps never clone a repo, so there is
     * nothing to check out. Accepted only for structural compatibility with
     * {@link TaskRuntimeEnvironmentOrchestrator}.
     */
    sourceBranch?: string | null | undefined;
    opencodeMcpJson?: OpenCodeMcpServers | null | undefined;
    currentExecutionInfo: {
      taskId: string;
      resultSchemaJson: Record<string, unknown> | null;
    };
    reporter?: WorkReporter | undefined;
    taskId?: string | undefined;
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
    /**
     * Opt-in hook that bakes a fake AI provider into the launch-time inline
     * config, pointed at `baseUrl`, instead of PATCHing `/config` on an
     * already-running agent (proven to have zero live effect — see #109).
     * Set by `run --dry-run` (#109/#110) and, since #120, by real step
     * execution for steps that declare `healthChecks` — a step declaring none
     * never sets this field, so it launches unaffected exactly as before.
     */
    fakeAiProviderOverride?: { baseUrl: string } | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s `stepEnv`. */
    stepEnv?: Readonly<Record<string, string>> | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    resolveMcpEnv?:
      ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s field of the same name. */
    preserveRuntimeOnFailure?: boolean | undefined;
    /** Accepted for contract parity; a no-workspace step has no devcontainer. */
    devcontainerConfigPath?: string | null | undefined;
    /** Ignored: no-workspace steps have no container, managed or otherwise. */
    managedRuntime?: string | null | undefined;
    /**
     * Accepted for contract parity. A no-workspace step never clones, which is
     * exactly repo mode `none`, so there is nothing to act on.
     */
    repo: RepoConfig;
    /** Accepted for contract parity; there is no commit to render. */
    stepInputJson?: unknown;
    /** See `TaskRuntimeEnvironmentOrchestrator.launch`'s `previousRun`. */
    previousRun?: PreviousRunFilesInput | undefined;
    /** Receives the skipped-transcript reason, so it ships in the step log. */
    logger?: ProjectWorkLogger | undefined;
  }): Promise<TaskRuntimeEnvironment> {
    if (!input.startAgent) {
      throw new Error(
        "A no_workspace step always runs an agent: the no_workspace runtime " +
          "cannot launch without starting OpenCode (startAgent must be true).",
      );
    }
    const reporter = input.reporter ?? noopReporter;
    const taskId = input.taskId ?? input.currentExecutionInfo.taskId;
    // Session-scoped host agent HOME, cleaned up below.
    const sessionAgentHomeDir = resolveSessionAgentHomeDir(input.sessionId);
    let workspacePath: string | null = null;
    let hostPid: number | null = null;

    try {
      logWork("runtime", "Creating no_workspace runtime environment", {
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
      });

      // Step 1: Create the throwaway host working directory (no clone).
      workspacePath = path.join(
        os.tmpdir(),
        "boboddy-noworkspace",
        input.sessionId,
      );
      await mkdir(workspacePath, { recursive: true });
      logWork("runtime", "No-workspace temp working dir created", {
        sessionId: input.sessionId,
        workspacePath,
      });

      // Step 2: Write current-execution metadata the Boboddy findings tool reads.
      const currentExecutionInfoPath = await writeCurrentExecutionInfoFile(
        workspacePath,
        input.currentExecutionInfo,
      );
      logWork("runtime", "Current execution metadata written", {
        sessionId: input.sessionId,
        workspacePath,
        currentExecutionInfoPath,
        taskId: input.currentExecutionInfo.taskId,
      });
      if (input.previousRun) {
        await writePreviousRunFiles(
          workspacePath,
          input.previousRun,
          input.logger,
        );
      }

      // Guarantee a clean slate: no leftover findings submission file from a
      // reused temp dir. Symmetric with the workspace runtime path.
      await removeFindingsSubmissionFile(workspacePath);

      // Step 3: Resolve the step's MCP server refs, then build the OpenCode
      // context (embedded Boboddy plugin + step MCPs) into the temp
      // workspace. Same builder as the workspace path; returns the inline
      // override config.
      const mcpLaunch = applyStepMcpEnv({
        plan: await planStepMcpServers({
          servers: input.opencodeMcpJson,
          workspacePath,
          sessionId: input.sessionId,
        }),
        stepEnv: input.stepEnv,
        resolveMcpEnv: input.resolveMcpEnv,
      });
      const { opencodeConfigContent } = await buildOpencodeContext({
        workspacePath,
        stepMcpServers: mcpLaunch.servers,
        providerOverride: input.fakeAiProviderOverride
          ? buildFakeProviderConfig(input.fakeAiProviderOverride.baseUrl)
          : undefined,
      });
      logWork("runtime", "OpenCode context built (no_workspace)", {
        sessionId: input.sessionId,
        workspacePath,
      });

      // Step 4: Ensure the runtime payload + compute the HOST wrapper path (the
      // same launch.sh executed directly on the host — it selects the right
      // standalone binary for the host arch/libc).
      const payload = await this.deps.payloadProvisioner.ensure();
      const hostLaunchWrapperPath = path.join(
        payload.hostPayloadDir,
        LAUNCH_WRAPPER_FILENAME,
      );
      logWork("runtime", "OpenCode runtime payload ready (no_workspace)", {
        sessionId: input.sessionId,
        version: payload.version,
        hostPayloadDir: payload.hostPayloadDir,
        hostLaunchWrapperPath,
      });

      // Step 5: Resolve + materialize provider access (same resolver/materializer
      // as the workspace path); only the env is needed for the host process.
      const providerAccess = await this.deps.providerAccessResolver.resolve({
        projectId: input.projectId,
        sessionId: input.sessionId,
        requestedByUserId: input.requestedByUserId,
      });
      const materialized =
        await this.deps.runtimeConfigMaterializer.materialize({
          runtimeContainerId: input.sessionId,
          workspaceFolder: workspacePath,
          providerAccess,
        });
      logWork("runtime", "Provider access resolved (no_workspace)", {
        sessionId: input.sessionId,
        providerMode: providerAccess.mode,
        providerEnvKeys: Object.keys(materialized.env).sort(),
      });

      const credentials = await this.deps.loadCredentials({
        launcherPath: hostLaunchWrapperPath,
        onWarning: (message) => {
          logWorkWarn("runtime", message, { sessionId: input.sessionId });
        },
      });
      logWork("runtime", "OpenCode credentials loaded (no_workspace)", {
        sessionId: input.sessionId,
        integrations: credentials.map(({ integrationID, source }) => ({
          integrationID,
          source,
        })),
      });
      const secretValues = [
        ...Object.values(materialized.env),
        ...opencodeCredentialSecrets(credentials),
        ...mcpLaunch.secretValues,
      ];

      // Step 6: Prepare the session-scoped agent HOME with the user's global
      // config (same copy rules as the container path). Credentials are
      // injected over the API once the server is up.
      await mkdir(sessionAgentHomeDir, { recursive: true });
      const { hostConfigPath } = await prepareAgentHomeConfig({
        sessionAgentHomeDir,
      });
      logWork("runtime", "Agent HOME global config prepared (no_workspace)", {
        sessionId: input.sessionId,
        hostConfigPath: hostConfigPath ?? "(none)",
      });

      // Step 7: Start OpenCode on the host and wait for health.
      reporter.event({
        type: "task:runtime-ai-starting",
        taskId,
      });
      const started = await this.deps.hostOpencodeBootstrap.start({
        hostLaunchWrapperPath,
        workspaceFolder: workspacePath,
        sessionAgentHomeDir,
        providerEnv: materialized.env,
        credentials,
        stepEnv: mcpLaunch.stepEnv,
        opencodeConfigContent,
        expectedVersion: payload.version,
        onLogReady: ({ agentLogDirectory, agentLogPath }) => {
          input.onAgentLogReady?.({
            logDirectory: agentLogDirectory,
            hostLogPath: agentLogPath,
            secretValues,
          });
        },
      });
      hostPid = started.pid;
      logWork("runtime", "Host OpenCode started (no_workspace)", {
        sessionId: input.sessionId,
        agentBaseUrl: started.agentBaseUrl,
        pid: started.pid,
        workspacePath,
      });

      const capturedWorkspacePath = workspacePath;
      const capturedPid = started.pid;

      return {
        workspacePath: capturedWorkspacePath,
        // OpenCode runs on the host against the temp workdir directly.
        workspaceFolder: capturedWorkspacePath,
        // No clone: there is no resolved branch.
        resolvedBranch: "",
        // No repo: no work branch is created here.
        workBranch: null,
        createdFromBranch: null,
        // No devcontainer.
        devcontainerConfigPath: "",
        // No container: callers must treat this as "not a container".
        runtimeContainerId: null,
        agent: {
          baseUrl: started.agentBaseUrl,
          password: started.serverPassword,
          version: payload.version,
          logDirectory: started.agentLogDirectory,
          hostLogPath: started.agentLogPath,
        },
        // No AI image is used; surface the pinned OpenCode runtime version.
        aiImage: `opencode-runtime@${payload.version}`,
        networkName: "",
        // Provider token(s) injected into the host process (Path B).
        secretValues,
        // No container health to check for host runs — omit the probe so the
        // monitor skips it.
        cleanup: async () => {
          this.deps.hostOpencodeBootstrap.stop(capturedPid);
          await Promise.allSettled([
            rm(capturedWorkspacePath, { recursive: true, force: true }),
            cleanupSessionHome(sessionAgentHomeDir),
          ]);
        },
      };
    } catch (error) {
      logWork(
        "runtime",
        "No-workspace runtime environment launch failed; cleaning up",
        {
          sessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // Always stop the process: a kept directory is for inspection, and a
      // half-started server left running would only leak.
      this.deps.hostOpencodeBootstrap.stop(hostPid);
      if (input.preserveRuntimeOnFailure) {
        logWork(
          "runtime",
          "Preserving no-workspace runtime artifacts after failed launch",
          {
            sessionId: input.sessionId,
            workspacePath,
            sessionAgentHomeDir,
            agentLogPath: path.join(
              sessionAgentHomeDir,
              ".boboddy-log",
              HOST_AGENT_SERVE_LOG_FILENAME,
            ),
          },
        );
        throw error;
      }
      await Promise.allSettled([
        workspacePath
          ? rm(workspacePath, { recursive: true, force: true })
          : Promise.resolve(),
        cleanupSessionHome(sessionAgentHomeDir),
      ]);
      throw error;
    }
  }
}
