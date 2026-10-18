import type {
  ProviderAccess,
  ProviderAccessResolver,
  ResolveProviderAccessInput,
} from "../../contracts/agent-runtime/provider-access-resolver";
import { noopLogger, type Logger } from "@boboddy/observability/logging/host";
import {
  listOpencodeAuthProviders,
  type ListOpencodeAuthProvidersInput,
} from "./opencode-credential-discovery";

/**
 * `direct` implementation of {@link ProviderAccessResolver}.
 *
 * Resolution precedence (locked decision):
 *   1. Explicit worker-host env/config override (highest precedence).
 *   2. The user's local OpenCode credentials (fallback).
 *
 * Both sources are host/worker-level ONLY. No project-level provider secrets
 * are read. For (2) the resolver only confirms a credential exists
 * (`opencode-credential-discovery.ts`); the credentials themselves never travel
 * through {@link ProviderAccess} — the bootstraps inject them into the session's
 * server over its API after boot (`opencode-credential-injection.ts`).
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
   * Override the OpenCode credential listing delegate (for tests). Defaults to
   * the real {@link listOpencodeAuthProviders}.
   */
  listProviders?:
    ((input: ListOpencodeAuthProvidersInput) => Promise<string[]>) | undefined;
  /** Host home dir forwarded to OpenCode credential discovery (for tests). */
  homeDir?: string | undefined;
  /** Logger forwarded to credential discovery. Defaults to a no-op logger. */
  logger?: Logger | undefined;
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
  private readonly listProviders: NonNullable<
    DirectProviderAccessResolverOptions["listProviders"]
  >;
  private readonly homeDir: string | undefined;
  private readonly logger: Logger;

  constructor(options: DirectProviderAccessResolverOptions = {}) {
    this.env = options.env ?? processEnvSource;
    this.listProviders = options.listProviders ?? listOpencodeAuthProviders;
    this.homeDir = options.homeDir;
    this.logger = options.logger ?? noopLogger;
  }

  async resolve(input: ResolveProviderAccessInput): Promise<ProviderAccess> {
    // The run identifiers are not needed for local direct resolution (sources
    // are host/worker-level), but the contract requires them and brokered mode
    // will use them. Reference to satisfy strict no-unused-vars.
    void input;
    const override = resolveEnvOverride(this.env);
    if (override) {
      return override;
    }

    const providers = await this.listProviders({
      homeDir: this.homeDir,
      logger: this.logger,
    });
    if (providers.length > 0) {
      return { mode: "direct" };
    }

    throw new ProviderAccessUnresolvedError();
  }
}

/**
 * Thrown when neither an explicit worker-host override nor a local OpenCode
 * credential is available for a `direct` resolution.
 */
export class ProviderAccessUnresolvedError extends Error {
  constructor() {
    super(
      "Could not resolve direct provider access: no worker-host override " +
        `(set ${PROVIDER_ACCESS_ENV_VARS.baseUrl} and/or ` +
        `${PROVIDER_ACCESS_ENV_VARS.tokenEnv}) and no local OpenCode ` +
        "credential was found (run `opencode auth login` or export a provider " +
        "API key such as ANTHROPIC_API_KEY).",
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
