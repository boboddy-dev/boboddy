import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { noopLogger, type Logger } from "@boboddy/observability/logging/host";

/**
 * OpenCode-specific credential discovery.
 *
 * This is the ONLY place in the worker that knows about OpenCode's local
 * credential layout (`auth.json`) and the host paths it lives under. The
 * direct provider-access resolver delegates here so the launcher/orchestrator
 * never reference credential paths directly.
 *
 * Hardening (per the migration plan's credential isolation boundary):
 * - Reads ONLY the specific OpenCode config/data paths below, never a broad
 *   sweep of the host home directory.
 * - Never returns secret values, only the env var name a token is exposed
 *   under plus the discovered config file path(s).
 */

/**
 * Relative location of the OpenCode auth store under the host home. OpenCode
 * persists provider credentials to `~/.local/share/opencode/auth.json`.
 */
const OPENCODE_AUTH_RELATIVE_PATH = [
  ".local",
  "share",
  "opencode",
  "auth.json",
] as const;

/**
 * Relative location of the OpenCode config directory under the host home
 * (`~/.config/opencode`). Used only to surface a discovered config file path,
 * not scanned recursively.
 */
const OPENCODE_CONFIG_RELATIVE_DIR = [".config", "opencode"] as const;

/** Provider id OpenCode uses for the first-party Anthropic provider. */
const DEFAULT_DISCOVERY_PROVIDER_ID = "anthropic";

/**
 * Env var name under which a discovered token is exposed to the runtime. The
 * discovery layer never embeds the secret in the contract; it reports the env
 * name and the materializer is responsible for placing the value there.
 */
const DISCOVERED_TOKEN_ENV = "BOBODDY_PROVIDER_TOKEN";

/**
 * The minimal shape of an OpenCode `auth.json` entry we understand. OpenCode
 * stores api-key credentials as `{ type: "api", key: "<token>" }` and OAuth
 * credentials as `{ type: "oauth", access: "<token>", refresh?: "<token>",
 * expires?: <ms> }`.
 *
 * For OAuth entries we use the `access` token directly as the credential
 * value. Refresh-token rotation is not performed here — if the access token
 * is expired we warn and proceed, since OpenCode may have already refreshed
 * it in the background.
 */
type OpencodeApiAuthEntry = {
  type: "api";
  key: string;
};

type OpencodeOAuthAuthEntry = {
  type: "oauth";
  access: string;
  refresh?: string | undefined;
  expires?: number | undefined;
};

type OpencodeAuthEntry =
  | OpencodeApiAuthEntry
  | OpencodeOAuthAuthEntry
  | { type: string };

/** Result of a successful OpenCode credential discovery. */
export type DiscoveredOpencodeCredential = {
  /** Provider id the credential was discovered for (e.g. `anthropic`). */
  providerId: string;
  /** Env var name the token value will be exposed under. */
  tokenEnv: string;
  /** The discovered token value. Kept internal to the OpenCode adapter. */
  tokenValue: string;
  /**
   * Absolute paths of OpenCode config files relevant to the run (the
   * `auth.json` that supplied the token, plus a config dir entry if present).
   */
  configFiles: string[];
};

export type DiscoverOpencodeCredentialInput = {
  /**
   * Host home directory to resolve OpenCode paths against. Injected for
   * testability and to avoid relying on ambient `os.homedir()` in tests.
   */
  homeDir?: string | undefined;
  /** Provider id to look up inside `auth.json`. Defaults to `anthropic`. */
  providerId?: string | undefined;
  /**
   * Logger for warnings (e.g. expired OAuth tokens). Defaults to a no-op
   * logger.
   */
  logger?: Logger | undefined;
};

/**
 * Resolve the host home directory, honoring an explicit `HOME` override. On
 * macOS, `os.homedir()` reads the OS user database and ignores `process.env`,
 * so prefer the env var when set. Mirrors the launcher's `resolveHostHome`.
 */
function resolveHostHome(): string {
  const explicit = process.env["HOME"]?.trim();
  return explicit && explicit.length > 0 ? explicit : os.homedir();
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isApiAuthEntry(value: unknown): value is OpencodeApiAuthEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<OpencodeAuthEntry> & { key?: unknown };
  return entry.type === "api" && typeof entry.key === "string";
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isOAuthAuthEntry(value: unknown): value is OpencodeOAuthAuthEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<OpencodeOAuthAuthEntry>;
  return (
    entry.type === "oauth" &&
    typeof entry.access === "string" &&
    entry.access.length > 0
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readAuthEntry(
  authPath: string,
  providerId: string,
): Promise<OpencodeApiAuthEntry | OpencodeOAuthAuthEntry | undefined> {
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const entry = (parsed as Record<string, unknown>)[providerId];
  if (isApiAuthEntry(entry)) return entry;
  if (isOAuthAuthEntry(entry)) return entry;
  return undefined;
}

/**
 * Discover a usable OpenCode credential for the given provider from the local
 * OpenCode auth store. Returns `undefined` when no usable credential is
 * present (no file, unparseable file, missing/unrecognised entry).
 *
 * When an OAuth entry's `expires` timestamp is in the past, a warning is
 * logged and the access token is returned anyway — OpenCode may have already
 * refreshed it in the background.
 *
 * Reads ONLY:
 *   - `<home>/.local/share/opencode/auth.json`
 *   - `<home>/.config/opencode/opencode.json[c]` (existence check only)
 */
export async function discoverOpencodeCredential(
  input: DiscoverOpencodeCredentialInput = {},
): Promise<DiscoveredOpencodeCredential | undefined> {
  const homeDir = input.homeDir?.trim() || resolveHostHome();
  const providerId = input.providerId?.trim() || DEFAULT_DISCOVERY_PROVIDER_ID;
  const logger = input.logger ?? noopLogger;

  const authPath = path.join(homeDir, ...OPENCODE_AUTH_RELATIVE_PATH);
  const entry = await readAuthEntry(authPath, providerId);
  if (!entry) {
    return undefined;
  }

  const tokenValue = isApiAuthEntry(entry) ? entry.key : entry.access;

  const configFiles = [authPath];

  const configDir = path.join(homeDir, ...OPENCODE_CONFIG_RELATIVE_DIR);
  for (const configName of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(configDir, configName);
    if (await pathExists(candidate)) {
      configFiles.push(candidate);
      break;
    }
  }

  // OAuth entry — warn if the stored expiry has passed. We proceed regardless
  // since OpenCode may have already refreshed the token in the background.
  if (
    !isApiAuthEntry(entry) &&
    typeof entry.expires === "number" &&
    entry.expires > 0 &&
    Date.now() >= entry.expires
  ) {
    const expiredAt = new Date(entry.expires);
    logger.warn(
      { providerId, expiredAt: expiredAt.toISOString() },
      `OpenCode OAuth credential for provider "${providerId}" expired at ` +
        `${expiredAt.toISOString()}. Proceeding anyway — OpenCode may have ` +
        `already refreshed it. Re-authenticate via OpenCode if the provider ` +
        `call fails.`,
    );
  }

  return {
    providerId,
    tokenEnv: DISCOVERED_TOKEN_ENV,
    tokenValue,
    configFiles,
  };
}

/**
 * List the provider ids that have a usable credential in the local OpenCode
 * auth store, sorted alphabetically.
 *
 * Returns provider NAMES ONLY — never tokens, key material, or any part of a
 * credential value. Used by the CLI to tell the user whether `opencode auth
 * login` still needs to be run before an interactive session can start.
 *
 * Reads ONLY `<home>/.local/share/opencode/auth.json`.
 */
export async function listOpencodeAuthProviders(
  input: { homeDir?: string | undefined } = {},
): Promise<string[]> {
  const homeDir = input.homeDir?.trim() || resolveHostHome();
  const authPath = path.join(homeDir, ...OPENCODE_AUTH_RELATIVE_PATH);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }

  return Object.entries(parsed as Record<string, unknown>)
    .filter(([, entry]) => isApiAuthEntry(entry) || isOAuthAuthEntry(entry))
    .map(([providerId]) => providerId)
    .sort((left, right) => left.localeCompare(right));
}

export const __opencodeCredentialDiscoveryInternals = {
  DISCOVERED_TOKEN_ENV,
  DEFAULT_DISCOVERY_PROVIDER_ID,
  resolveHostHome,
};
