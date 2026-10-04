import path from "node:path";
import { buildOpencodeContext } from "@boboddy/opencode-plugin";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { OpenCodePlugins } from "../../../common/contracts/opencode-plugin";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type { PlanMountsResult } from "../../../runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import type { OpencodeRuntimePayloadLocation } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { logWork } from "../application/work-logger";
import type { MaterializeRuntimeConfigResult } from "../contracts/agent-runtime/runtime-config-materializer";
import type { AgentRuntime } from "../contracts/process-project-work-types";
import type { WorkReporter } from "../contracts/work-reporter";
import { buildFakeProviderConfig } from "./fake-ai";
import type { LocalProjectRuntimeEnvironmentDeps } from "./local-project-runtime-environment-deps";

type AgentLaunchDeps = Pick<
  LocalProjectRuntimeEnvironmentDeps,
  | "payloadProvisioner"
  | "providerAccessResolver"
  | "runtimeConfigMaterializer"
  | "opencodeBootstrap"
>;

/**
 * Everything the pre-container agent stage produced and the post-container
 * stage consumes: the OpenCode runtime payload, the materialized provider
 * config/env, and the mount + host-port plan already patched into the
 * devcontainer config.
 */
export type AgentLaunchPlan = {
  payload: OpencodeRuntimePayloadLocation;
  materialized: MaterializeRuntimeConfigResult;
  mountPlan: PlanMountsResult;
};

/**
 * Pre-container agent work: ensure the OpenCode runtime payload, resolve and
 * materialize provider access, then plan and patch the devcontainer config with
 * the read-only payload/provider mounts, the published port, and the
 * host-gateway runArgs. Skipped entirely for steps that do not start an agent.
 */
export async function prepareAgentLaunch(input: {
  deps: AgentLaunchDeps;
  sessionId: UuidV7;
  projectId: UuidV7;
  requestedByUserId: UuidV7;
  workspacePath: string;
  devcontainerConfigPath: string;
  agentWorkspaceFolder: string;
}): Promise<AgentLaunchPlan> {
  const { deps } = input;

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

  return { payload, materialized, mountPlan };
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
  stepEnv?: Readonly<Record<string, string>> | undefined;
  opencodeMcpJson?: OpenCodeMcpServers | null | undefined;
  opencodePluginJson?: OpenCodePlugins | null | undefined;
  fakeAiProviderOverride?: { baseUrl: string } | undefined;
  reporter: WorkReporter;
  stepExecutionId: string;
}): Promise<AgentRuntime> {
  const { deps, plan } = input;

  // The agent HOME lives on the container's overlay filesystem, so it can only
  // be seeded once the container is running: the user's host global opencode
  // config and provider auth are piped in. The project repo is untouched.
  const { hostConfigPath, hostAuthPath } =
    await deps.opencodeBootstrap.prepareAgentHome({
      containerId: input.containerId,
    });
  logWork("runtime", "Agent HOME global config prepared", {
    sessionId: input.sessionId,
    hostConfigPath: hostConfigPath ?? "(none — no host global config found)",
    hostAuthPath: hostAuthPath ?? "(none — no host auth.json found)",
  });

  // The project's `.opencode/opencode.json` is never written. Boboddy's
  // required additions (permission baseline, step MCPs, AGENT_DEFAULT_MODEL)
  // travel as OPENCODE_CONFIG_CONTENT (precedence #6) and win over the user's
  // home config seeded above. User `.opencode/tools` and npm `plugin[]` entries
  // are trusted and load directly in the in-container OpenCode.
  const { opencodeConfigContent } = await buildOpencodeContext({
    workspacePath: input.workspacePath,
    stepMcpServers: input.opencodeMcpJson,
    stepPlugins: input.opencodePluginJson,
    providerOverride: input.fakeAiProviderOverride
      ? buildFakeProviderConfig(input.fakeAiProviderOverride.baseUrl)
      : undefined,
  });
  logWork("runtime", "OpenCode context built", {
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    npmPluginCount: input.opencodePluginJson?.length ?? 0,
  });

  input.reporter.event({
    type: "step:runtime-ai-starting",
    stepExecutionId: input.stepExecutionId,
  });
  const opencodeStart = await deps.opencodeBootstrap.start({
    containerId: input.containerId,
    workspaceFolder: input.agentWorkspaceFolder,
    hostPort: plan.mountPlan.hostPort,
    launchWrapperPath: plan.payload.containerLaunchWrapperPath,
    providerEnv: plan.materialized.env,
    stepEnv: input.stepEnv,
    opencodeConfigContent,
  });
  logWork("runtime", "In-devcontainer OpenCode started", {
    sessionId: input.sessionId,
    devcontainerId: input.containerId,
    agentBaseUrl: opencodeStart.agentBaseUrl,
    agentWorkspaceFolder: input.agentWorkspaceFolder,
  });

  return {
    baseUrl: opencodeStart.agentBaseUrl,
    logDirectory: opencodeStart.agentLogDirectory,
  };
}
