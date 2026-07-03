import type { UuidV7 } from "../../../../common/contracts/uuid-v7";

/**
 * Provider access mode.
 *
 * - `direct`: the runtime talks to the provider directly using a base URL and a
 *   token sourced from the environment (and/or discovered local config).
 *   Implemented in Phase 2.
 * - `brokered`: the runtime talks to a Boboddy-owned proxy/broker that holds the
 *   upstream provider credentials. Deferred future work — only the contract
 *   shape exists so it can be added without a rewrite.
 */
export type ProviderAccessMode = "direct" | "brokered";

/**
 * Normalized provider access for a run. Decouples "how the runtime reaches the
 * provider" from runtime startup, so credentials are a separate concern.
 *
 * Per the locked decision the shape is exactly:
 * `{ mode, baseUrl?, tokenEnv?, configFiles?, headers? }`.
 */
export type ProviderAccess = {
  mode: ProviderAccessMode;
  /** Provider/base URL the runtime should target, when applicable. */
  baseUrl?: string | undefined;
  /**
   * Name of the environment variable that holds the provider token. The token
   * value itself is never embedded in this contract.
   */
  tokenEnv?: string | undefined;
  /**
   * Read-only config files the runtime needs mounted/materialized (e.g. a
   * discovered local OpenCode `auth.json`). Empty/omitted when none are needed.
   */
  configFiles?: string[] | undefined;
  /** Extra headers the runtime should send to the provider/broker. */
  headers?: Record<string, string> | undefined;
};

/** Input describing the run for which provider access must be resolved. */
export type ResolveProviderAccessInput = {
  projectId: UuidV7;
  sessionId: UuidV7;
  requestedByUserId: UuidV7;
};

/**
 * Resolves a run into normalized {@link ProviderAccess}. Phase 0 declares the
 * contract only; the `direct` implementation (env/config override > discovered
 * local OpenCode config) lands in Phase 2. No discovery logic exists yet.
 */
export type ProviderAccessResolver = {
  resolve(input: ResolveProviderAccessInput): Promise<ProviderAccess>;
};
