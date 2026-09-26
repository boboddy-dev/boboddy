import { existsSync, lstatSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { writeJsonFileAtomically } from "./atomic-json-file";
import { resolveHomeDir } from "./home-dir";
import { migrateLegacyConfigIfNeeded } from "./legacy-config-migration";

export const DEFAULT_ARTIFACT_LOCAL_MAX_BYTES = 2 * 1024 ** 3; // 2 GiB
export const DEFAULT_ARTIFACT_LOCAL_MAX_AGE_DAYS = 14;

export interface ArtifactRetentionSettings {
  localMaxBytes: number;
  localMaxAgeDays: number;
}

export interface ConfigFile {
  /**
   * A random id generated on first read and persisted here — it identifies
   * this machine/install before any account exists, so pre-auth CLI
   * telemetry (init started, requirements verified) has a stable distinct
   * id to key events to. See `getOrCreateAnonymousId`.
   */
  anonymousId?: string;
  /**
   * User-level telemetry opt-out, set via `boboddy telemetry disable` (or
   * the `BOBODDY_TELEMETRY_DISABLED` env var, checked separately at the
   * call site). Global — unlike auth profiles, it is not scoped to a
   * `baseUrl`.
   */
  telemetryDisabled?: boolean;
  artifacts: ArtifactRetentionSettings;
}

const authFilePath = () => join(resolveHomeDir(), ".boboddy", "auth.jsonc");
const configFilePath = () =>
  join(resolveHomeDir(), ".boboddy", "config.jsonc");

export const getConfigFilePath = () => configFilePath();

// A function, not a shared constant, for the same reason `auth-file.ts`
// uses `emptyAuthFile()` rather than a singleton: callers spread this into
// a new object before writing back (see `getOrCreateAnonymousId`), but
// nothing should ever be able to hand out (and thus risk a future caller
// mutating) the one shared default `artifacts` object across unrelated
// load calls.
const defaultConfigFile = (): ConfigFile => ({
  artifacts: {
    localMaxBytes: DEFAULT_ARTIFACT_LOCAL_MAX_BYTES,
    localMaxAgeDays: DEFAULT_ARTIFACT_LOCAL_MAX_AGE_DAYS,
  },
});

function isArtifactRetentionSettings(
  // eslint-disable-next-line local/no-unknown-parameter-type
  value: unknown,
): value is ArtifactRetentionSettings {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["localMaxBytes"] === "number" &&
    typeof obj["localMaxAgeDays"] === "number"
  );
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isConfigFile(value: unknown): value is ConfigFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (
    obj["anonymousId"] !== undefined &&
    typeof obj["anonymousId"] !== "string"
  ) {
    return false;
  }
  if (
    obj["telemetryDisabled"] !== undefined &&
    typeof obj["telemetryDisabled"] !== "boolean"
  ) {
    return false;
  }
  return isArtifactRetentionSettings(obj["artifacts"]);
}

const loadConfigFileFromPath = (filePath: string): ConfigFile => {
  if (!existsSync(filePath)) return defaultConfigFile();
  if (!lstatSync(filePath).isFile()) return defaultConfigFile();

  const content = readFileSync(filePath, "utf8");
  if (content.trim().length === 0) return defaultConfigFile();

  // `config.jsonc` tolerates comments and trailing commas (jsonc-parser),
  // unlike the strict `JSON.parse` this replaced — any other parse error
  // still falls back to defaults, same as before.
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(content, errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) return defaultConfigFile();
  if (!isConfigFile(parsed)) return defaultConfigFile();
  return parsed;
};

/**
 * See the matching comment in `auth-file.ts`: both modules must trigger
 * `migrateLegacyConfigIfNeeded` from their own `loadX`, but neither may
 * import the other, so `auth.jsonc`'s path is mirrored here rather than
 * imported from `auth-file.ts`. `auth-file.ts` is the source of truth for
 * that path string; if it ever changes, update both call sites.
 */
export const loadConfigFile = (): ConfigFile => {
  migrateLegacyConfigIfNeeded({
    authFileExists: () => existsSync(authFilePath()),
    configFileExists: () => existsSync(configFilePath()),
    writeAuthFile: (profiles) => {
      writeJsonFileAtomically(authFilePath(), { profiles });
    },
    writeConfigFile: (fields) => {
      writeJsonFileAtomically(configFilePath(), {
        ...fields,
        artifacts: defaultConfigFile().artifacts,
      });
    },
  });

  return loadConfigFileFromPath(configFilePath());
};

const writeConfigFile = (data: ConfigFile) => {
  writeJsonFileAtomically(configFilePath(), data);
};

/**
 * The persisted pre-auth distinct id for this machine/install, creating and
 * persisting one the first time it is read. Stable across every command
 * invocation until `~/.boboddy/config.jsonc` is deleted or edited by hand —
 * unlike `auth.jsonc`, nothing in this package deletes `config.jsonc`
 * automatically (telemetry settings survive `boboddy auth logout`, matching
 * today's behavior).
 */
export const getOrCreateAnonymousId = (): string => {
  const configFile = loadConfigFile();
  if (configFile.anonymousId) return configFile.anonymousId;

  const anonymousId = randomUUID();
  writeConfigFile({ ...configFile, anonymousId });
  return anonymousId;
};

/** The persisted telemetry opt-out flag. Defaults to `false` (enabled). */
export const isTelemetryDisabled = (): boolean =>
  loadConfigFile().telemetryDisabled === true;

/** Persist the telemetry opt-out flag, leaving everything else intact. */
export const setTelemetryDisabled = (disabled: boolean): void => {
  const configFile = loadConfigFile();
  writeConfigFile({ ...configFile, telemetryDisabled: disabled });
};

export const getArtifactRetentionSettings = (): ArtifactRetentionSettings =>
  loadConfigFile().artifacts;
