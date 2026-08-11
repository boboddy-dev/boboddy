import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildOpencodeContext } from "@boboddy/opencode-plugin";
import {
  removeFindingsSubmissionFile,
  writeCurrentExecutionInfoFile,
} from "../application/process-project-work-findings";
import { logWork } from "../application/work-logger";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { OpenCodePlugins } from "../../../common/contracts/opencode-plugin";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  StepExecutionRuntimeEnvironment,
  StepExecutionRuntimeEnvironmentOrchestrator,
} from "../contracts/process-project-work-types";
import { OpencodeRuntimePayloadProvisioner } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import {
  cleanupSessionHome,
  prepareAgentHomeConfig,
  resolveSessionAgentHomeDir,
} from "../../../runtime/runtime-service/infra/opencode-agent-home";
import { LAUNCH_WRAPPER_FILENAME } from "../../../runtime/runtime-service/domain/opencode-runtime-payload";
import { HostOpencodeBootstrap } from "../../../runtime/runtime-service/infra/host-opencode-bootstrap";
import { noopReporter, type WorkReporter } from "../contracts/work-reporter";
import { noopLogger, type Logger } from "@boboddy/observability/logging/host";
import type { ProviderAccessResolver } from "../contracts/agent-runtime/provider-access-resolver";
import type { RuntimeConfigMaterializer } from "../contracts/agent-runtime/runtime-config-materializer";
import { DirectProviderAccessResolver } from "./provider-access/direct-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "./provider-access/session-runtime-config-materializer";
import { buildFakeProviderConfig } from "./fake-ai";

export type LocalNoWorkspaceRuntimeEnvironmentOrchestrator =
  StepExecutionRuntimeEnvironmentOrchestrator;

/**
 * `no_workspace` launch orchestrator.
 *
 * Runs OpenCode DIRECTLY ON THE HOST against a throwaway temp working
 * directory. There is NO git clone and NO devcontainer: the step runs with only
 * the rendered prompt + provided context. Everything else — step MCP servers,
 * step plugins, the embedded Boboddy findings plugin, provider credentials,
 * `resultSchemaJson` validation, log/conversation streaming, completion — works
 * exactly as on the `workspace` path, because we reuse the same context builder,
 * execution-info file, provider-access resolution, and payload wrapper.
 *
 * Implements the same {@link StepExecutionRuntimeEnvironmentOrchestrator}
 * contract as the devcontainer orchestrator and returns the same
 * {@link StepExecutionRuntimeEnvironment} shape, with `runtimeContainerId: null`
 * (no container) and `hostAgentLogPath` set so the monitor tails the host log
 * file rather than doing `docker exec`.
 */
export class DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator implements LocalNoWorkspaceRuntimeEnvironmentOrchestrator {
  constructor(
    private readonly logger: Logger = noopLogger,
    private readonly deps: {
      payloadProvisioner: OpencodeRuntimePayloadProvisioner;
      providerAccessResolver: ProviderAccessResolver;
      runtimeConfigMaterializer: RuntimeConfigMaterializer;
      hostOpencodeBootstrap: HostOpencodeBootstrap;
    } = {
      payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
      providerAccessResolver: new DirectProviderAccessResolver({ logger }),
      runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
        outputBaseDir: path.join(os.tmpdir(), "boboddy-provider-config"),
      }),
      hostOpencodeBootstrap: new HostOpencodeBootstrap(),
    },
  ) {}

  async launch(input: {
    sessionId: UuidV7;
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    gitUrl: string;
    baseWorkBranch?: string | null | undefined;
    /**
     * Unused here: `no_workspace` steps never clone a repo, so there is
     * nothing to check out. Accepted only for structural compatibility with
     * {@link StepExecutionRuntimeEnvironmentOrchestrator}.
     */
    sourceBranch?: string | null | undefined;
    opencodeMcpJson?: OpenCodeMcpServers | null | undefined;
    opencodePluginJson?: OpenCodePlugins | null | undefined;
    currentExecutionInfo: {
      stepExecutionId: string;
      resultSchemaJson: Record<string, unknown> | null;
    };
    reporter?: WorkReporter | undefined;
    stepExecutionId?: string | undefined;
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
  }): Promise<StepExecutionRuntimeEnvironment> {
    const reporter = input.reporter ?? noopReporter;
    const stepExecutionId =
      input.stepExecutionId ?? input.currentExecutionInfo.stepExecutionId;
    // Session-scoped host agent HOME (config + auth), cleaned up below.
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
        stepExecutionId: input.currentExecutionInfo.stepExecutionId,
      });

      // Guarantee a clean slate: no leftover findings submission file from a
      // reused temp dir. Symmetric with the workspace runtime path.
      await removeFindingsSubmissionFile(workspacePath);

      // Step 3: Build the OpenCode context (embedded Boboddy plugin + step
      // MCPs/plugins) into the temp workspace. Same builder as the workspace
      // path; returns the inline override config.
      const { opencodeConfigContent } = await buildOpencodeContext({
        workspacePath,
        stepMcpServers: input.opencodeMcpJson,
        stepPlugins: input.opencodePluginJson,
        providerOverride: input.fakeAiProviderOverride
          ? buildFakeProviderConfig(input.fakeAiProviderOverride.baseUrl)
          : undefined,
      });
      logWork("runtime", "OpenCode context built (no_workspace)", {
        sessionId: input.sessionId,
        workspacePath,
        npmPluginCount: input.opencodePluginJson?.length ?? 0,
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

      // Step 6: Prepare the session-scoped agent HOME with the user's global
      // config + provider auth (same copy rules as the container path).
      await mkdir(sessionAgentHomeDir, { recursive: true });
      const { hostConfigPath, hostAuthPath } = await prepareAgentHomeConfig({
        sessionAgentHomeDir,
      });
      logWork("runtime", "Agent HOME global config prepared (no_workspace)", {
        sessionId: input.sessionId,
        hostConfigPath: hostConfigPath ?? "(none)",
        hostAuthPath: hostAuthPath ?? "(none)",
      });

      // Step 7: Start OpenCode on the host and wait for health.
      reporter.event({ type: "step:runtime-ai-starting", stepExecutionId });
      const started = await this.deps.hostOpencodeBootstrap.start({
        hostLaunchWrapperPath,
        workspaceFolder: workspacePath,
        sessionAgentHomeDir,
        providerEnv: materialized.env,
        opencodeConfigContent,
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
        opencodeLogDirectory: started.agentLogDirectory,
        hostAgentLogPath: started.agentLogPath,
        // No clone: there is no resolved branch.
        resolvedBranch: "",
        // No repo: no work branch is created here.
        workBranch: null,
        createdFromBranch: null,
        // No devcontainer.
        devcontainerConfigPath: "",
        // No container: callers must treat this as "not a container".
        runtimeContainerId: null,
        agentBaseUrl: started.agentBaseUrl,
        // No AI image is used; surface the pinned OpenCode runtime version.
        aiImage: `opencode-runtime@${payload.version}`,
        networkName: "",
        // Provider token(s) injected into the host process (Path B).
        secretValues: Object.values(materialized.env),
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
      this.deps.hostOpencodeBootstrap.stop(hostPid);
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
