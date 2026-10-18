import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CredentialKey, CredentialOAuth } from "@opencode/client";
import {
  LAUNCH_WRAPPER_FILENAME,
  hostOpencodeRuntimeVersionDir,
  resolveHostHome,
  resolveOpencodeRuntimeVersion,
} from "../domain/opencode-runtime-payload";

/**
 * The user's OpenCode provider credentials, read from their REAL home.
 *
 * OpenCode 2.x keeps credentials in its SQLite store, not in a file Boboddy
 * could copy, so the source is the pinned runtime's own
 * `auth export --standalone` (no background service is left running). Its
 * stdout is held in memory only — never written to disk, logged, or quoted in
 * an error. Two lower-precedence sources are merged under it: a v1 `auth.json`
 * (read-only, for users who have not logged in with v2 yet) and the well-known
 * provider API-key env vars. Per integration, export beats `auth.json` beats env.
 *
 * The result is injected into each session's server over `POST /api/credential`
 * (see `opencode-credential-injection.ts`). Every secret it carries must be
 * registered with the session's `SecretMasker` ({@link opencodeCredentialSecrets}).
 */

export type OpencodeCredentialValue =
  | Pick<CredentialKey, "type" | "key" | "metadata">
  | Pick<
      CredentialOAuth,
      "type" | "methodID" | "refresh" | "access" | "expires" | "metadata"
    >;

export type OpencodeCredentialSourceKind = "export" | "auth.json" | "env";

export type OpencodeCredential = {
  integrationID: string;
  value: OpencodeCredentialValue;
  source: OpencodeCredentialSourceKind;
};

/**
 * Well-known provider API-key env vars OpenCode accepts without a stored
 * credential, mapped to the integration they authenticate.
 */
export const PROVIDER_API_KEY_ENV_VARS: ReadonlyArray<
  readonly [envVar: string, integrationID: string]
> = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["GEMINI_API_KEY", "google"],
  ["GOOGLE_GENERATIVE_AI_API_KEY", "google"],
  ["OPENROUTER_API_KEY", "openrouter"],
  ["GROQ_API_KEY", "groq"],
  ["XAI_API_KEY", "xai"],
  ["DEEPSEEK_API_KEY", "deepseek"],
];

export type LoadOpencodeCredentialsInput = {
  /**
   * Host launcher (`launch.sh`) of the pinned runtime used for the export.
   * `undefined` uses the already-provisioned runtime in the host cache if one
   * exists (never downloads); `null` skips the export and reads only `auth.json`.
   */
  launcherPath?: string | null | undefined;
  /** Host home override (tests). Defaults to `HOME`/`os.homedir()`. */
  homeDir?: string | undefined;
  /**
   * Env the export inherits `PATH`/`XDG_*` from, and the provider API-key env
   * vars are read from. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv | undefined;
  /** Called with a message that never contains credential material. */
  onWarning?: ((message: string) => void) | undefined;
  /** Injected export runner (tests). */
  runExport?: ((input: RunExportInput) => Promise<string>) | undefined;
};

export type OpencodeCredentialLoader = (
  input?: LoadOpencodeCredentialsInput,
) => Promise<OpencodeCredential[]>;

export type RunExportInput = {
  launcherPath: string;
  env: NodeJS.ProcessEnv;
};

const EXPORT_TIMEOUT_MS = 30_000;
const XDG_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const;

/** Load and merge the user's v2 export, v1 `auth.json` and env credentials. */
export async function loadOpencodeCredentials(
  input: LoadOpencodeCredentialsInput = {},
): Promise<OpencodeCredential[]> {
  const sourceEnv = input.env ?? process.env;
  const homeOverride = input.homeDir?.trim();
  const homeDir = homeOverride || resolveHostHome((name) => sourceEnv[name]);
  const env = buildExportEnv(sourceEnv, homeDir, !homeOverride);
  const warn = input.onWarning ?? (() => undefined);

  const legacy = await readLegacyAuthJson(env);
  const launcherPath =
    input.launcherPath === undefined
      ? await resolveCachedHostLauncher(homeDir)
      : input.launcherPath;

  let exported: OpencodeCredential[] = [];
  if (launcherPath !== null) {
    try {
      const stdout = await (input.runExport ?? runAuthExport)({
        launcherPath,
        env,
      });
      exported = parseAuthExport(stdout);
    } catch (error) {
      warn(
        "Could not export OpenCode credentials with `auth export --standalone`; " +
          `using only auth.json (${describeExportError(error)})`,
      );
    }
  }

  const merged = new Map<string, OpencodeCredential>();
  for (const credential of [
    ...readEnvCredentials(sourceEnv),
    ...legacy,
    ...exported,
  ]) {
    merged.set(credential.integrationID, credential);
  }
  return [...merged.values()].sort((left, right) =>
    left.integrationID.localeCompare(right.integrationID),
  );
}

/** Every secret string a credential list carries, for the `SecretMasker`. */
export function opencodeCredentialSecrets(
  credentials: readonly OpencodeCredential[],
): string[] {
  return credentials.flatMap(({ value }) =>
    value.type === "key" ? [value.key] : [value.access, value.refresh],
  );
}

/**
 * The provisioned host launcher for the pinned version, or `null` when the
 * runtime has not been provisioned yet. Never downloads anything.
 */
export async function resolveCachedHostLauncher(
  homeDir: string,
): Promise<string | null> {
  const launcher = path.join(
    hostOpencodeRuntimeVersionDir(homeDir, resolveOpencodeRuntimeVersion()),
    LAUNCH_WRAPPER_FILENAME,
  );
  try {
    await access(launcher);
    return launcher;
  } catch {
    return null;
  }
}

/**
 * A minimal env for the export: `HOME`, `PATH`, and — unless the home was
 * overridden, which must fully isolate tests from the real user dirs — the
 * caller's `XDG_*` dirs.
 */
function buildExportEnv(
  source: NodeJS.ProcessEnv,
  homeDir: string,
  inheritXdg: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: homeDir };
  if (source["PATH"] !== undefined) {
    env["PATH"] = source["PATH"];
  }
  if (!inheritXdg) {
    return env;
  }
  for (const key of XDG_KEYS) {
    if (source[key]?.trim()) {
      env[key] = source[key];
    }
  }
  return env;
}

/**
 * Parse the `auth export` JSON array. Inactive entries are skipped, and only
 * the key and OAuth credential kinds are kept — `external` credentials are
 * bound to the machine that created them.
 */
export function parseAuthExport(stdout: string): OpencodeCredential[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("auth export did not return a JSON array");
  }
  const credentials: OpencodeCredential[] = [];
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const integrationID = record["integrationID"];
    const value = toCredentialValue(record["value"]);
    if (
      typeof integrationID !== "string" ||
      value === null ||
      record["active"] === false
    ) {
      continue;
    }
    credentials.push({ integrationID, value, source: "export" });
  }
  return credentials;
}

/** API keys from {@link PROVIDER_API_KEY_ENV_VARS}; the first set var wins. */
export function readEnvCredentials(
  env: NodeJS.ProcessEnv,
): OpencodeCredential[] {
  const byIntegration = new Map<string, OpencodeCredential>();
  for (const [envVar, integrationID] of PROVIDER_API_KEY_ENV_VARS) {
    const key = env[envVar]?.trim();
    if (key && !byIntegration.has(integrationID)) {
      byIntegration.set(integrationID, {
        integrationID,
        value: { type: "key", key },
        source: "env",
      });
    }
  }
  return [...byIntegration.values()];
}

// eslint-disable-next-line local/no-unknown-parameter-type
function toCredentialValue(raw: unknown): OpencodeCredentialValue | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const metadata = isRecord(value["metadata"])
    ? (value["metadata"] as OpencodeCredentialValue["metadata"])
    : undefined;
  if (value["type"] === "key" && isNonEmpty(value["key"])) {
    return { type: "key", key: value["key"], ...(metadata && { metadata }) };
  }
  if (
    value["type"] === "oauth" &&
    isNonEmpty(value["methodID"]) &&
    isNonEmpty(value["access"]) &&
    typeof value["refresh"] === "string" &&
    typeof value["expires"] === "number"
  ) {
    return {
      type: "oauth",
      methodID: value["methodID"],
      refresh: value["refresh"],
      access: value["access"],
      expires: value["expires"],
      ...(metadata && { metadata }),
    };
  }
  return null;
}

/**
 * Read the v1 `auth.json` (`$XDG_DATA_HOME/opencode/auth.json`) and translate
 * it the way OpenCode's own legacy-credential import does: `api` and
 * `wellknown` become keys, `oauth` keeps its tokens under the provider's
 * default OAuth method.
 */
export async function readLegacyAuthJson(
  env: NodeJS.ProcessEnv,
): Promise<OpencodeCredential[]> {
  const dataHome =
    env["XDG_DATA_HOME"]?.trim() ||
    path.join(env["HOME"] ?? os.homedir(), ".local", "share");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(path.join(dataHome, "opencode", "auth.json"), "utf8"),
    );
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const credentials: OpencodeCredential[] = [];
  for (const [rawId, entry] of Object.entries(parsed)) {
    const integrationID = rawId.replace(/\/+$/u, "");
    const value = legacyEntryToValue(integrationID, entry);
    if (integrationID && value) {
      credentials.push({ integrationID, value, source: "auth.json" });
    }
  }
  return credentials;
}

function legacyEntryToValue(
  integrationID: string,
  // eslint-disable-next-line local/no-unknown-parameter-type
  entry: unknown,
): OpencodeCredentialValue | null {
  if (!isRecord(entry)) {
    return null;
  }
  if (entry["type"] === "api" && isNonEmpty(entry["key"])) {
    return { type: "key", key: entry["key"] };
  }
  if (entry["type"] === "wellknown" && isNonEmpty(entry["token"])) {
    return { type: "key", key: entry["token"] };
  }
  if (entry["type"] === "oauth" && isNonEmpty(entry["access"])) {
    return {
      type: "oauth",
      methodID: legacyOAuthMethod(integrationID),
      refresh: typeof entry["refresh"] === "string" ? entry["refresh"] : "",
      access: entry["access"],
      expires: typeof entry["expires"] === "number" ? entry["expires"] : 0,
    };
  }
  return null;
}

function legacyOAuthMethod(integrationID: string): string {
  if (integrationID === "openai") {
    return "chatgpt-browser";
  }
  if (["github-copilot", "opencode", "xai"].includes(integrationID)) {
    return "device";
  }
  return "oauth";
}

/**
 * Spawn `<launcher> auth export --standalone` from an empty temp dir, so no
 * project config is loaded, and resolve its stdout. Errors carry the exit
 * status only — stdout and stderr may hold secrets.
 */
export async function runAuthExport(input: RunExportInput): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "boboddy-auth-export-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(
        input.launcherPath,
        ["auth", "export", "--standalone"],
        { cwd, env: input.env, stdio: ["ignore", "pipe", "ignore"] },
      );
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`timed out after ${String(EXPORT_TIMEOUT_MS)}ms`));
      }, EXPORT_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString("utf8"));
        } else {
          reject(
            new Error(
              code !== null
                ? `exited with code ${String(code)}`
                : `killed by ${signal ?? "signal"}`,
            ),
          );
        }
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function describeExportError(error: unknown): string {
  if (error instanceof SyntaxError) {
    return "output was not valid JSON";
  }
  return error instanceof Error ? error.message : "unknown error";
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
