import type {
  ProviderAccess,
  ProviderAccessResolver,
  ResolveProviderAccessInput,
} from "../../contracts/agent-runtime/provider-access-resolver";
import { noopLogger, type Logger } from "../../../../lib/logger";
import type { DiscoverOpencodeCredentialInput } from "./opencode-credential-discovery";
import { discoverOpencodeCredential } from "./opencode-credential-discovery";

/**
 * `direct` implementation of {@link ProviderAccessResolver}.
 *
 * Resolution precedence (locked decision):
 *   1. Explicit worker-host env/config override (highest precedence).
 *   2. Discovered local OpenCode config (fallback).
 *
 * Both sources are host/worker-level ONLY. No project-level provider secrets
 * are read. OpenCode-specific credential discovery is delegated to
 * `opencode-credential-discovery.ts`; this resolver never reads credential
 * paths itself.
 *
 * Only `mode: "direct"` is implemented. `brokered` remains a declared seam.
 */

/** Worker-host env var names for the explicit provider-access override. */
export const PROVIDER_ACCESS_ENV_VARS = {
  /** Base/endpoint URL the runtime should target. */
  baseUrl: "BOBODDY_PROVIDER_BASE_URL",
  /**
   * Name of the env var that holds the provider token (indirection — this
   * names another env var; it is not the token itself).
   */
  tokenEnv: "BOBODDY_PROVIDER_TOKEN_ENV",
  /**
   * Comma-separated absolute paths of read-only config files the runtime
   * needs. Optional.
   */
  configFiles: "BOBODDY_PROVIDER_CONFIG_FILES",
  /**
   * JSON object of extra headers to send to the provider/broker. Optional.
   * Example: `{"x-org":"acme"}`.
   */
  headers: "BOBODDY_PROVIDER_HEADERS",
} as const;

/**
 * Minimal env source abstraction so the resolver is testable without mutating
 * the global `process.env`. Defaults to reading `process.env`.
 */
export type EnvSource = (name: string) => string | undefined;

const processEnvSource: EnvSource = (name) => process.env[name];

export type DirectProviderAccessResolverOptions = {
  /** Env source for the explicit worker-host override. Defaults to process.env. */
  env?: EnvSource | undefined;
  /**
   * Override the OpenCode credential discovery delegate (for tests). Defaults
   * to the real {@link discoverOpencodeCredential}.
   */
  discover?:
    | ((
        input: DiscoverOpencodeCredentialInput,
      ) => Promise<Awaited<ReturnType<typeof discoverOpencodeCredential>>>)
    | undefined;
  /** Host home dir forwarded to OpenCode discovery (for tests). */
  homeDir?: string | undefined;
  /**
   * Logger forwarded to OpenCode credential discovery (e.g. for expired-token
   * warnings). Defaults to a no-op logger.
   */
  logger?: Logger | undefined;
  /**
   * Env setter used to expose a discovered token value into the process
   * environment so the materializer can read it. Defaults to writing into
   * `process.env`. Injectable for tests.
   */
  setEnv?: ((name: string, value: string) => void) | undefined;
};

function parseHeaders(raw: string): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseConfigFiles(raw: string): string[] | undefined {
  const files = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return files.length > 0 ? files : undefined;
}

/**
 * Build a {@link ProviderAccess} from the explicit worker-host override, or
 * `undefined` if no override is configured. An override is considered present
 * when at least one of base URL or token env is set, since those are the
 * meaningful direct-access knobs.
 */
function resolveEnvOverride(env: EnvSource): ProviderAccess | undefined {
  const baseUrl = env(PROVIDER_ACCESS_ENV_VARS.baseUrl)?.trim();
  const tokenEnv = env(PROVIDER_ACCESS_ENV_VARS.tokenEnv)?.trim();

  const hasBaseUrl = Boolean(baseUrl && baseUrl.length > 0);
  const hasTokenEnv = Boolean(tokenEnv && tokenEnv.length > 0);
  if (!hasBaseUrl && !hasTokenEnv) {
    return undefined;
  }

  const access: ProviderAccess = { mode: "direct" };
  if (hasBaseUrl) {
    access.baseUrl = baseUrl;
  }
  if (hasTokenEnv) {
    access.tokenEnv = tokenEnv;
  }

  const rawConfigFiles = env(PROVIDER_ACCESS_ENV_VARS.configFiles)?.trim();
  if (rawConfigFiles && rawConfigFiles.length > 0) {
    const configFiles = parseConfigFiles(rawConfigFiles);
    if (configFiles) {
      access.configFiles = configFiles;
    }
  }

  const rawHeaders = env(PROVIDER_ACCESS_ENV_VARS.headers)?.trim();
  if (rawHeaders && rawHeaders.length > 0) {
    const headers = parseHeaders(rawHeaders);
    if (headers) {
      access.headers = headers;
    }
  }

  return access;
}

export class DirectProviderAccessResolver implements ProviderAccessResolver {
  private readonly env: EnvSource;
  private readonly discover: NonNullable<
    DirectProviderAccessResolverOptions["discover"]
  >;
  private readonly homeDir: string | undefined;
  private readonly logger: Logger;
  private readonly setEnv: NonNullable<
    DirectProviderAccessResolverOptions["setEnv"]
  >;

  constructor(options: DirectProviderAccessResolverOptions = {}) {
    this.env = options.env ?? processEnvSource;
    this.discover = options.discover ?? discoverOpencodeCredential;
    this.homeDir = options.homeDir;
    this.logger = options.logger ?? noopLogger;
    this.setEnv =
      options.setEnv ??
      ((name, value) => {
        process.env[name] = value;
      });
  }

  async resolve(input: ResolveProviderAccessInput): Promise<ProviderAccess> {
    // The run identifiers are not needed for local direct resolution (sources
    // are host/worker-level), but the contract requires them and brokered mode
    // will use them. Reference to satisfy strict no-unused-vars.
    void input;
    // 1. Explicit worker-host env/config override wins.
    const override = resolveEnvOverride(this.env);
    if (override) {
      return override;
    }

    // 2. Fallback: discovered local OpenCode config (delegated to the
    //    OpenCode-specific adapter; this resolver never reads credential
    //    paths itself).
    const discovered = await this.discover({
      homeDir: this.homeDir,
      logger: this.logger,
    });
    if (discovered) {
      // Seed the discovered token value into the environment under its
      // designated env var name so the session materializer can read it via
      // its EnvSource without needing access to the raw token value.
      this.setEnv(discovered.tokenEnv, discovered.tokenValue);
      return {
        mode: "direct",
        tokenEnv: discovered.tokenEnv,
        configFiles: discovered.configFiles,
      };
    }

    // 3. Neither source present: a usable direct access could not be resolved.
    throw new ProviderAccessUnresolvedError();
  }
}

/**
 * Thrown when neither an explicit worker-host override nor a discovered local
 * OpenCode credential is available for a `direct` resolution.
 */
export class ProviderAccessUnresolvedError extends Error {
  constructor() {
    super(
      "Could not resolve direct provider access: no worker-host override " +
        `(set ${PROVIDER_ACCESS_ENV_VARS.baseUrl} and/or ` +
        `${PROVIDER_ACCESS_ENV_VARS.tokenEnv}) and no local OpenCode ` +
        "credential was discovered.",
    );
    this.name = "ProviderAccessUnresolvedError";
  }
}

/**
 * Thrown if a `brokered` resolution is requested. Brokered mode is a declared
 * seam only; it is intentionally not implemented in Phase 2.
 */
export class BrokeredProviderAccessNotImplementedError extends Error {
  constructor() {
    super(
      "Brokered provider access is a declared seam and is not implemented yet.",
    );
    this.name = "BrokeredProviderAccessNotImplementedError";
  }
}
