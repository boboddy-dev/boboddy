export {
  CoreError,
  CoreValidationError,
  ResourceNotFoundError,
  ResourceConflictError,
  ResourceOwnershipError,
  InvariantViolationError,
  PersistenceError,
  ConfigurationError,
} from "./lib/errors";
export {
  parseJsonc,
  stripJsoncComments,
  stripTrailingCommas,
} from "./lib/jsonc";
export { systemTimeProvider } from "./lib/time-provider";
export type { TimeProvider } from "./lib/time-provider";
export {
  anyJsonArraySchema,
  anyJsonObjectSchema,
  anyJsonValueSchema,
} from "./common/contracts/json";
export type {
  AnyJsonArray,
  AnyJsonObject,
  AnyJsonPrimitive,
  AnyJsonValue,
} from "./common/contracts/json";
export {
  createUuidV7,
  isUuidV7,
  parseUuidV7,
} from "./common/contracts/uuid-v7";
export type { UuidV7 } from "./common/contracts/uuid-v7";
export type { OpenCodeMcpServers } from "./common/contracts/opencode-mcp";
export {
  CLI_AUTH_CLIENT_ID,
  resolveBoboddyBaseUrl,
} from "./auth/session/infra/auth-config";
export { createCliAuthClient } from "./auth/session/infra/auth-client";
export {
  deleteAuthProfile,
  getAuthFilePath,
  getOrCreateAnonymousId,
  isTelemetryDisabled,
  loadAuthFile,
  loadAuthProfile,
  saveAuthProfile,
  setTelemetryDisabled,
} from "./auth/session/infra/auth-storage";
export type { AuthFile, AuthProfile } from "./auth/session/domain/session";
export { fetchAuthenticatedSession } from "./auth/session/application/fetch-authenticated-session";
export { loadAuthenticatedSession } from "./auth/session/application/load-authenticated-session";
export { persistAuthenticatedSession } from "./auth/session/application/persist-authenticated-session";
export { pollForAccessToken } from "./auth/session/application/poll-for-access-token";
export { requestDeviceAuthorization } from "./auth/session/application/request-device-authorization";
export { readProjectConfig } from "./project/project-config/application/read-project-config";
export { writeProjectConfig } from "./project/project-config/application/write-project-config";
export {
  deriveProjectName,
  loadProjectConfig,
  saveProjectConfig,
} from "./project/project-config/infra/fs-project-config-repo";
export type { ProjectConfig } from "./project/project-config/domain/project-config";
export {
  resolveSourceBranch,
  SourceBranchVerificationError,
} from "./project/source-branch/application/resolve-source-branch";
export type {
  ResolveSourceBranchInput,
  SourceBranchGitPort,
} from "./project/source-branch/application/resolve-source-branch";
export { GitCliSourceBranchPort } from "./project/source-branch/infra/git-cli-source-branch-port";
export {
  DEVCONTAINER_CONFIG_PATH,
  hasDevcontainer,
} from "./project/project-setup/application/ensure-devcontainer";
export { localConfigSetup } from "./project/project-setup/application/local-config-setup";
export type { LocalConfigSetupResult } from "./project/project-setup/application/local-config-setup";
export { findMatchingProject } from "./project/project-setup/application/find-matching-project";
export type { MatchedProject } from "./project/project-setup/application/find-matching-project";
export { completeProjectHandoff } from "./project/project-setup/application/complete-project-handoff";
export {
  findGitRoot,
  resolveGitRepository,
} from "./project/project-setup/application/resolve-git-repository";
export type { ResolvedGitRepository } from "./project/project-setup/application/resolve-git-repository";
export { verifyRequirements } from "./project/project-setup/application/verify-requirements";
export { RuntimeNetworkGarbageCollector } from "./runtime/runtime-gc/application/runtime-network-garbage-collector";
export {
  DevcontainerCliLauncher,
  buildDevcontainerCliCommand,
  resolveDevcontainerCliScriptPath,
} from "./runtime/runtime-service/infra/devcontainer-cli-launcher";
export { OpencodeRuntimePayloadProvisioner } from "./runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
export type { OpencodeRuntimePayloadLocation } from "./runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
export {
  OPENCODE_RUNTIME_VERSION,
  resolveHostNativePlatform,
  resolveOpencodeRuntimeVersion,
} from "./runtime/runtime-service/domain/opencode-runtime-payload";
export type {
  OpencodePayloadProgressListener,
  OpencodePayloadProvisionProgress,
  PayloadPlatform,
} from "./runtime/runtime-service/domain/opencode-runtime-payload";
export {
  PIPELINE_DESIGNER_AGENT_NAME,
  PIPELINE_DESIGNER_BASH_PERMISSIONS,
  PIPELINE_DESIGNER_EDIT_PERMISSIONS,
  buildDesignerPermissions,
  buildOpencodeTuiConfig,
  resolvePermission,
  serializeOpencodeTuiConfig,
} from "./runtime/host-opencode-tui/domain/opencode-tui-config";
export type {
  BuildOpencodeTuiConfigInput,
  OpencodeAgentPermissionConfig,
  OpencodeInjectedAgentConfig,
  OpencodeInjectedConfig,
  OpencodePermissionAction,
  OpencodePermissionRules,
} from "./runtime/host-opencode-tui/domain/opencode-tui-config";
export {
  assertInteractiveTerminal,
  buildOpencodeTuiArgs,
  buildOpencodeTuiEnv,
  ensureHostOpencodePayload,
  hasFailedExitCode,
  launchOpencodeAuthLogin,
  launchOpencodeTui,
  resolveHostOpencodeBinary,
} from "./runtime/host-opencode-tui/infra/host-opencode-tui-launcher";
export type {
  EnsureHostOpencodePayloadOptions,
  LaunchOpencodeAuthLoginInput,
  LaunchOpencodeTuiInput,
  LaunchOpencodeTuiResult,
} from "./runtime/host-opencode-tui/infra/host-opencode-tui-launcher";
export { checkOpencodeProviderCredentials } from "./runtime/host-opencode-tui/application/check-opencode-provider-credentials";
export type {
  CheckOpencodeProviderCredentialsInput,
  OpencodeProviderCredentialCheck,
} from "./runtime/host-opencode-tui/application/check-opencode-provider-credentials";
export {
  PIPELINE_BUILDER_DIR,
  PIPELINE_BUILDER_TSCONFIG,
  PIPELINE_BUILDER_TYPECHECK_SCRIPT,
  PIPELINE_BUILDER_TYPECHECK_SCRIPT_NAME,
  STARTER_PIPELINE_FILENAME,
  buildPipelineBuilderPackageJson,
  scaffoldPipelineBuilderDirectory,
} from "./pipelines/pipeline-definitions/infra/pipeline-builder-scaffolder";
export { detectPipelineRuntime } from "./pipelines/pipeline-definitions/infra/detect-pipeline-runtime";
export type { PipelineRuntime } from "./pipelines/pipeline-definitions/infra/detect-pipeline-runtime";
export {
  pullPipelineDefinitions,
  listExistingPipelineBuilderFiles,
} from "./pipelines/pipeline-definitions/application/pull-pipeline-definitions";
export type { PullPipelineDefinitionsResult } from "./pipelines/pipeline-definitions/application/pull-pipeline-definitions";
export {
  UnsupportedRuleError,
  generateDefaultPipelineAssignmentFileContent,
} from "./pipelines/pipeline-definitions/infra/default-pipeline-assignment-file-generator";
export type { DefaultPipelineAssignmentContract } from "./pipelines/pipeline-definitions/infra/default-pipeline-assignment-file-generator";
export { LocalArtifactStore } from "./artifacts/artifact-store/infra/local-artifact-store";
export { RemoteArtifactStore } from "./artifacts/artifact-store/infra/remote-artifact-store";
export { CompositeArtifactStore } from "./artifacts/artifact-store/infra/composite-artifact-store";
export { resolveArtifactStores } from "./artifacts/artifact-store/infra/resolve-artifact-stores";
export type { ResolveArtifactStoresOptions } from "./artifacts/artifact-store/infra/resolve-artifact-stores";
export type {
  ArtifactStore,
  SaveArtifactInput,
  SaveArtifactResult,
} from "./artifacts/artifact-store/domain/artifact-store";
export { DefaultOpencodeStepRunner } from "./work/step-execution/infra/opencode-step-runner";
export {
  processProjectWork,
  runProjectWork,
} from "./work/step-execution/application/run-project-work";
export type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkOptions,
  ProcessProjectWorkResult,
  LocalRuntimeSessionStore,
} from "./work/step-execution/application/run-project-work";
export { noopReporter } from "./work/step-execution/contracts/work-reporter";
export type {
  WorkEvent,
  WorkReporter,
  WorkTask,
} from "./work/step-execution/contracts/work-reporter";
export {
  runWorkDryRun,
  listProjectStepDefinitionsForDryRun,
} from "./work/step-execution/application/run-work-dry-run";
export type {
  HealthCheckOutcome,
  HealthCheckReport,
  McpHandshakeReport,
  WorkDryRunOptions,
  WorkDryRunReport,
  WorkDryRunScope,
} from "./work/step-execution/application/run-work-dry-run";
export {
  resolveFirstStepDefinitionId,
  runPipelineFirstStepDryRun,
} from "./work/step-execution/application/run-pipeline-first-step-dry-run";
export type { PipelineFirstStepDryRunOptions } from "./work/step-execution/application/run-pipeline-first-step-dry-run";
export { computeStudioSnapshot } from "./pipelines/pipeline-studio/application/compute-studio-snapshot";
export { runPipelineStudioServer } from "./pipelines/pipeline-studio/application/run-pipeline-studio-server";
export type {
  PipelineStudioServerHandle,
  RunPipelineStudioServerOptions,
} from "./pipelines/pipeline-studio/application/run-pipeline-studio-server";
