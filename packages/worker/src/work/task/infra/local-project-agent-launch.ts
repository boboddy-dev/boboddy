import path from "node:path";
import { buildOpencodeContext } from "@boboddy/opencode-plugin";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type { PlanMountsResult } from "../../../runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import type { OpencodeRuntimePayloadLocation } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { LAUNCH_WRAPPER_FILENAME } from "../../../runtime/runtime-service/domain/opencode-runtime-payload";
import {
  opencodeCredentialSecrets,
  type OpencodeCredential,
} from "../../../runtime/runtime-service/infra/opencode-credential-source";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../application/resolve-step-env";
import { logWork, logWorkWarn } from "../application/work-logger";
import type { MaterializeRuntimeConfigResult } from "../contracts/agent-runtime/runtime-config-materializer";
import type { AgentRuntime } from "../contracts/process-project-work-types";
import type { WorkReporter } from "../contracts/work-reporter";
import { buildFakeProviderConfig } from "./fake-ai";
import type { LocalProjectRuntimeEnvironmentDeps } from "./local-project-runtime-environment-deps";
import {
  applyStepMcpEnv,
  planStepMcpServers,
  type StepMcpLaunch,
} from "./resolve-launch-mcp-servers";

type AgentLaunchDeps = Pick<
  LocalProjectRuntimeEnvironmentDeps,
  | "payloadProvisioner"
  | "providerAccessResolver"
  | "runtimeConfigMaterializer"
  | "opencodeBootstrap"
  | "loadCredentials"
>;

/**
 * Everything the pre-container agent stage produced and the post-container
 * stage consumes: the step's MCP servers with every ref resolved, the OpenCode
 * runtime payload, the materialized provider config/env, the user's provider
 * credentials, and the mount + host-port plan already patched into the
 * devcontainer config.
 */
export type AgentLaunchPlan = {
  /** The step's MCP servers and the env to start OpenCode with (see `applyStepMcpEnv`). */
  mcp: StepMcpLaunch;
  payload: OpencodeRuntimePayloadLocation;
  materialized: MaterializeRuntimeConfigResult;
  credentials: readonly OpencodeCredential[];
  mountPlan: PlanMountsResult;
};

/** Every secret the agent launch hands to the runtime, for log masking. */
export function agentLaunchSecretValues(plan: AgentLaunchPlan): string[] {
  return [
    ...Object.values(plan.materialized.env),
    ...opencodeCredentialSecrets(plan.credentials),
    ...plan.mcp.secretValues,
  ];
}

/**
 * Pre-container agent work: resolve the step's MCP server refs against the
 * servers discovered in the cloned workspace and disable every other one,
 * then resolve the env they need (so a missing ref, or a `required` MCP's
 * missing variable, fails before the devcontainer starts), ensure the
 * OpenCode runtime payload, resolve and
 * materialize provider access, load the user's credentials with the payload's
 * host launcher, then plan and patch the devcontainer config with the
 * read-only payload/provider mounts, the published port, and the host-gateway
 * runArgs. Skipped entirely for steps that do not start an agent.
 */
export async function prepareAgentLaunch(input: {
  deps: AgentLaunchDeps;
  sessionId: UuidV7;
  projectId: UuidV7;
  requestedByUserId: UuidV7;
  workspacePath: string;
  devcontainerConfigPath: string;
  agentWorkspaceFolder: string;
  opencodeMcpJson?: OpenCodeMcpServers | null | undefined;
  stepEnv?: Readonly<Record<string, string>> | undefined;
  resolveMcpEnv?: ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
}): Promise<AgentLaunchPlan> {
  const { deps } = input;

  const mcp = applyStepMcpEnv({
    plan: await planStepMcpServers({
      servers: input.opencodeMcpJson,
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
    }),
    stepEnv: input.stepEnv,
    resolveMcpEnv: input.resolveMcpEnv,
  });

  const payload = await deps.payloadProvisioner.ensure();
  logWork("runtime", "OpenCode runtime payload ready", {
    sessionId: input.sessionId,
    version: payload.version,
    hostPayloadDir: payload.hostPayloadDir,
    containerPayloadDir: payload.containerPayloadDir,
  });

  const providerAccess = await deps.providerAccessResolver.resolve({
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestedByUserId: input.requestedByUserId,
  });
  const materialized = await deps.runtimeConfigMaterializer.materialize({
    runtimeContainerId: input.sessionId,
    workspaceFolder: input.agentWorkspaceFolder,
    providerAccess,
  });
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

  const credentials = await deps.loadCredentials({
    launcherPath: path.join(payload.hostPayloadDir, LAUNCH_WRAPPER_FILENAME),
    onWarning: (message) => {
      logWorkWarn("runtime", message, { sessionId: input.sessionId });
    },
  });
  logWork("runtime", "OpenCode credentials loaded", {
    sessionId: input.sessionId,
    integrations: credentials.map(({ integrationID, source }) => ({
      integrationID,
      source,
    })),
  });

  const mountPlan = await deps.opencodeBootstrap.planMounts({
    payload,
    providerConfigDir,
  });
  await deps.opencodeBootstrap.patchConfig({
    workspacePath: input.workspacePath,
    devcontainerConfigPath: input.devcontainerConfigPath,
    mounts: mountPlan.mounts,
    hostPort: mountPlan.hostPort,
  });
  logWork("runtime", "Patched devcontainer.json with OpenCode runtime mounts", {
    sessionId: input.sessionId,
    mountTargets: mountPlan.mounts.map((m) => m.target),
    hostPort: mountPlan.hostPort,
  });

  return { mcp, payload, materialized, credentials, mountPlan };
}

/**
 * Post-container agent work: seed the agent HOME into the running container,
 * build the OpenCode override config, and start `opencode serve` inside the
 * container from the mounted payload. Returns the host-facing agent runtime.
 */
export async function startAgentInContainer(input: {
  deps: AgentLaunchDeps;
  plan: AgentLaunchPlan;
  sessionId: UuidV7;
  containerId: string;
  workspacePath: string;
  agentWorkspaceFolder: string;
  fakeAiProviderOverride?: { baseUrl: string } | undefined;
  reporter: WorkReporter;
  taskId: string;
}): Promise<AgentRuntime> {
  const { deps, plan } = input;

  // The agent HOME lives on the container's overlay filesystem, so it can only
  // be seeded once the container is running: the user's host global opencode
  // config is piped in. The project repo is untouched.
  const { hostConfigPath } = await deps.opencodeBootstrap.prepareAgentHome({
    containerId: input.containerId,
  });
  logWork("runtime", "Agent HOME global config prepared", {
    sessionId: input.sessionId,
    hostConfigPath: hostConfigPath ?? "(none — no host global config found)",
  });

  // The project's `.opencode/opencode.json` is never written. Boboddy's
  // required additions (permission baseline, step MCPs, AGENT_DEFAULT_MODEL)
  // travel as OPENCODE_CONFIG_CONTENT (precedence #6) and win over the user's
  // home config seeded above. User `.opencode/tools` and npm `plugin[]` entries
  // are trusted and load directly in the in-container OpenCode.
  const { opencodeConfigContent } = await buildOpencodeContext({
    workspacePath: input.workspacePath,
    stepMcpServers: plan.mcp.servers,
    providerOverride: input.fakeAiProviderOverride
      ? buildFakeProviderConfig(input.fakeAiProviderOverride.baseUrl)
      : undefined,
  });
  logWork("runtime", "OpenCode context built", {
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
  });

  input.reporter.event({
    type: "task:runtime-ai-starting",
    taskId: input.taskId,
  });
  const opencodeStart = await deps.opencodeBootstrap.start({
    containerId: input.containerId,
    workspaceFolder: input.agentWorkspaceFolder,
    hostPort: plan.mountPlan.hostPort,
    launchWrapperPath: plan.payload.containerLaunchWrapperPath,
    providerEnv: plan.materialized.env,
    credentials: plan.credentials,
    stepEnv: plan.mcp.stepEnv,
    opencodeConfigContent,
    expectedVersion: plan.payload.version,
  });
  logWork("runtime", "In-devcontainer OpenCode started", {
    sessionId: input.sessionId,
    devcontainerId: input.containerId,
    agentBaseUrl: opencodeStart.agentBaseUrl,
    agentWorkspaceFolder: input.agentWorkspaceFolder,
  });

  return {
    baseUrl: opencodeStart.agentBaseUrl,
    password: opencodeStart.serverPassword,
    version: plan.payload.version,
    logDirectory: opencodeStart.agentLogDirectory,
  };
}
