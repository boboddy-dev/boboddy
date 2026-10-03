import os from "node:os";
import path from "node:path";
import type { Logger } from "@boboddy/observability/logging/host";
import type { DevcontainerLauncher } from "../../../runtime/runtime-service/application/devcontainer-launcher";
import type { GitCloneService } from "../../../runtime/runtime-service/application/git-clone-service";
import type { GitCommitPushService } from "../../../runtime/runtime-service/application/git-commit-push-service";
import type { SubmoduleService } from "../../../runtime/runtime-service/application/submodule-service";
import type { WorkspaceManager } from "../../../runtime/runtime-service/application/workspace-manager";
import { DevcontainerCliLauncher } from "../../../runtime/runtime-service/infra/devcontainer-cli-launcher";
import { DevcontainerOpencodeBootstrap } from "../../../runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import { createGitCloneService } from "../../../runtime/runtime-service/infra/create-git-clone-service";
import { GitCliCommitPushService } from "../../../runtime/runtime-service/infra/git-cli-commit-push-service";
import { GitCliSubmoduleService } from "../../../runtime/runtime-service/infra/git-cli-submodule-service";
import { LocalWorkspaceManager } from "../../../runtime/runtime-service/infra/local-workspace-manager";
import { OpencodeRuntimePayloadProvisioner } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import type { ProviderAccessResolver } from "../contracts/agent-runtime/provider-access-resolver";
import type { RuntimeConfigMaterializer } from "../contracts/agent-runtime/runtime-config-materializer";
import { DirectProviderAccessResolver } from "./provider-access/direct-provider-access-resolver";
import { SessionRuntimeConfigMaterializer } from "./provider-access/session-runtime-config-materializer";

export type LocalProjectRuntimeEnvironmentDeps = {
  workspaceManager: WorkspaceManager;
  gitCloneService: GitCloneService;
  /**
   * The git mirror cache dir `gitCloneService` reads from, exported to the
   * devcontainer CLI's host environment. `null` when the cache is off; absent
   * when the clone service was injected and has no known cache dir.
   */
  gitCacheDir?: string | null | undefined;
  gitCommitPushService: GitCommitPushService;
  submoduleService: SubmoduleService;
  devcontainerLauncher: DevcontainerLauncher;
  // Boboddy-managed OpenCode runtime payload + in-devcontainer bootstrap +
  // provider-access resolution/materialization.
  payloadProvisioner: OpencodeRuntimePayloadProvisioner;
  opencodeBootstrap: DevcontainerOpencodeBootstrap;
  providerAccessResolver: ProviderAccessResolver;
  runtimeConfigMaterializer: RuntimeConfigMaterializer;
};

/**
 * Builds the production deps for the single-container launch orchestrator. The
 * clone service comes from the shared `createGitCloneService` factory, configured
 * from `{...process.env, ...localEnvVars}`, so the real and dry-run
 * orchestrators share one code path. Throws a `ConfigurationError` for an
 * invalid git cache setting. `overrides` replace individual deps (the dry run
 * swaps in a safe provider-access resolver).
 */
export function buildLocalProjectRuntimeDeps(
  logger: Logger,
  localEnvVars: Record<string, string>,
  overrides: Partial<LocalProjectRuntimeEnvironmentDeps> = {},
): LocalProjectRuntimeEnvironmentDeps {
  const { gitCloneService, cacheDir } = createGitCloneService(
    { ...process.env, ...localEnvVars },
    logger,
  );
  return {
    workspaceManager: new LocalWorkspaceManager(),
    gitCloneService,
    gitCacheDir: cacheDir,
    gitCommitPushService: new GitCliCommitPushService(logger),
    submoduleService: new GitCliSubmoduleService(logger),
    devcontainerLauncher: new DevcontainerCliLauncher(),
    payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
    opencodeBootstrap: new DevcontainerOpencodeBootstrap(),
    providerAccessResolver: new DirectProviderAccessResolver({ logger }),
    runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
      outputBaseDir: path.join(os.tmpdir(), "boboddy-provider-config"),
    }),
    ...overrides,
  };
}
