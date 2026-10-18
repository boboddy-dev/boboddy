import type { ProviderAccess } from "./provider-access-resolver";

/**
 * Input for materializing runtime + provider config inside the runtime
 * container. Takes the normalized runtime location plus the resolved provider
 * access and writes whatever the agent (e.g. OpenCode) needs — session config
 * and/or environment — without coupling startup to credential file mounts.
 */
export type MaterializeRuntimeConfigInput = {
  /**
   * Identifier of the runtime container the config is materialized into. With
   * the single-container model this is the devcontainer id.
   */
  runtimeContainerId: string;
  /** Absolute path to the resolved workspace folder inside the container. */
  workspaceFolder: string;
  /** Normalized provider access resolved for the run. */
  providerAccess: ProviderAccess;
};

/** Result describing what the materializer wrote for the runtime. */
export type MaterializeRuntimeConfigResult = {
  /**
   * Environment variables the agent runtime must be launched with (e.g. the
   * provider token under its `tokenEnv` name). May be empty.
   */
  env: Record<string, string>;
  /**
   * Absolute paths of config files written for the agent runtime, if any.
   */
  configFiles?: string[] | undefined;
};

/**
 * Writes the runtime + provider configuration the agent needs inside the
 * container. Phase 0 declares the interface only; implementation lands in a
 * later phase alongside the OpenCode adapter.
 */
export type RuntimeConfigMaterializer = {
  materialize(
    input: MaterializeRuntimeConfigInput,
  ): Promise<MaterializeRuntimeConfigResult>;
};
