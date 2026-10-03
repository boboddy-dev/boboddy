import os from "node:os";
import path from "node:path";
import type { Logger } from "@boboddy/observability/logging/host";
import { OpencodeRuntimePayloadProvisioner } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { HostOpencodeBootstrap } from "../../../runtime/runtime-service/infra/host-opencode-bootstrap";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../infra/local-project-runtime-environment";
import { buildLocalProjectRuntimeDeps } from "../infra/local-project-runtime-environment-deps";
import { DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator } from "../infra/local-noworkspace-runtime-environment";
import { SessionRuntimeConfigMaterializer } from "../infra/provider-access/session-runtime-config-materializer";
import type { SafeProviderAccessResolver } from "../infra/provider-access/safe-provider-access-resolver";
import type { StepExecutionRuntimeEnvironmentOrchestrator } from "../contracts/process-project-work-types";

/**
 * Build a workspace-mode orchestrator with a {@link SafeProviderAccessResolver}
 * substituted for the default `DirectProviderAccessResolver`, so a missing
 * provider credential is reported rather than aborting the launch. Uses the
 * same default deps as `DefaultLocalProjectRuntimeEnvironmentOrchestrator`
 * (including the shared git clone service factory), except for that one swap.
 */
export function buildDryRunWorkspaceOrchestrator(
  logger: Logger,
  localEnvVars: Record<string, string>,
  safeProviderAccessResolver: SafeProviderAccessResolver,
): StepExecutionRuntimeEnvironmentOrchestrator {
  return new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
    logger,
    localEnvVars,
    buildLocalProjectRuntimeDeps(logger, localEnvVars, {
      providerAccessResolver: safeProviderAccessResolver,
    }),
  );
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
