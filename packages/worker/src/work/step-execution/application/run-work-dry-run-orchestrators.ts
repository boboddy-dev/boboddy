import os from "node:os";
import path from "node:path";
import type { Logger } from "../../../lib/logger";
import { GitCliCloneService } from "../../../runtime/runtime-service/infra/git-cli-clone-service";
import { GitCliCommitPushService } from "../../../runtime/runtime-service/infra/git-cli-commit-push-service";
import { GitCliSubmoduleService } from "../../../runtime/runtime-service/infra/git-cli-submodule-service";
import { DevcontainerCliLauncher } from "../../../runtime/runtime-service/infra/devcontainer-cli-launcher";
import { LocalWorkspaceManager } from "../../../runtime/runtime-service/infra/local-workspace-manager";
import { OpencodeRuntimePayloadProvisioner } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { DevcontainerOpencodeBootstrap } from "../../../runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import { HostOpencodeBootstrap } from "../../../runtime/runtime-service/infra/host-opencode-bootstrap";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../infra/local-project-runtime-environment";
import { DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator } from "../infra/local-noworkspace-runtime-environment";
import { SessionRuntimeConfigMaterializer } from "../infra/provider-access/session-runtime-config-materializer";
import type { SafeProviderAccessResolver } from "../infra/provider-access/safe-provider-access-resolver";
import type { StepExecutionRuntimeEnvironmentOrchestrator } from "../contracts/process-project-work-types";

/**
 * Build a workspace-mode orchestrator with a {@link SafeProviderAccessResolver}
 * substituted for the default `DirectProviderAccessResolver`, so a missing
 * provider credential is reported rather than aborting the launch. Mirrors the
 * default `deps` in `DefaultLocalProjectRuntimeEnvironmentOrchestrator`'s
 * constructor exactly, except for that one swap.
 */
export function buildDryRunWorkspaceOrchestrator(
  logger: Logger,
  localEnvVars: Record<string, string>,
  safeProviderAccessResolver: SafeProviderAccessResolver,
): StepExecutionRuntimeEnvironmentOrchestrator {
  return new DefaultLocalProjectRuntimeEnvironmentOrchestrator(logger, localEnvVars, {
    workspaceManager: new LocalWorkspaceManager(),
    gitCloneService: new GitCliCloneService(logger),
    gitCommitPushService: new GitCliCommitPushService(logger),
    submoduleService: new GitCliSubmoduleService(logger),
    devcontainerLauncher: new DevcontainerCliLauncher(),
    payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
    opencodeBootstrap: new DevcontainerOpencodeBootstrap(),
    providerAccessResolver: safeProviderAccessResolver,
    runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
      outputBaseDir: path.join(os.tmpdir(), "boboddy-provider-config"),
    }),
  });
}

/** Same swap as {@link buildDryRunWorkspaceOrchestrator}, for `no_workspace` steps. */
export function buildDryRunNoWorkspaceOrchestrator(
  logger: Logger,
  safeProviderAccessResolver: SafeProviderAccessResolver,
): StepExecutionRuntimeEnvironmentOrchestrator {
  return new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(logger, {
    payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
    providerAccessResolver: safeProviderAccessResolver,
    runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
      outputBaseDir: path.join(os.tmpdir(), "boboddy-provider-config"),
    }),
    hostOpencodeBootstrap: new HostOpencodeBootstrap(),
  });
}
