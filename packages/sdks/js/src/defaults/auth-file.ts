import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { writeJsonFileAtomically } from "./atomic-json-file";
import { resolveHomeDir } from "./home-dir";
import { migrateLegacyConfigIfNeeded } from "./legacy-config-migration";

export interface AuthProfile {
  accessToken: string;
  userId?: string;
  email?: string;
  name?: string;
}

export interface AuthFile {
  profiles: Record<string, AuthProfile>;
}

const authFilePath = () => join(resolveHomeDir(), ".boboddy", "auth.jsonc");
const configFilePath = () =>
  join(resolveHomeDir(), ".boboddy", "config.jsonc");

/**
 * `auth-file.ts` and `config-file.ts` both need to trigger the one-time
 * legacy-file migration from their own `loadX` entrypoint (decision 6 in the
 * plan: whichever module loads first performs the split), but neither may
 * import the other — `config-file.ts` needs the exact same two-sided setup,
 * so a mutual import would be a real cycle. `legacy-config-migration.ts`'s
 * `writeConfigFile` callback only ever needs to persist `anonymousId`/
 * `telemetryDisabled` plus a default-populated `artifacts` block (decision
 * 3: defaults are written the moment the file is first created, including
 * via migration) — reproduced here as plain values instead of importing
 * them from `config-file.ts`. `config-file.ts` is the source of truth for
 * these two numbers and for the `auth.jsonc` path string mirrored below; if
 * either ever changes, update both call sites.
 */
const MIGRATION_DEFAULT_ARTIFACT_RETENTION = {
  localMaxBytes: 2 * 1024 ** 3,
  localMaxAgeDays: 14,
};

// A function, not a shared constant: `saveAuthProfile` mutates the
// `profiles` object it gets back from `loadAuthFile` in place, so handing
// out the same object reference across calls would leak writes between
// unrelated load/save cycles within one process (e.g. a caller who deletes
// the file, then saves a fresh profile, would still see a stale profile
// from before the delete).
const emptyAuthFile = (): AuthFile => ({ profiles: {} });

// eslint-disable-next-line local/no-unknown-parameter-type
function isAuthProfile(value: unknown): value is AuthProfile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["accessToken"] !== "string") return false;
  for (const key of ["userId", "email", "name"]) {
    const v = obj[key];
    if (v !== undefined && typeof v !== "string") return false;
  }
  return true;
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isAuthFile(value: unknown): value is AuthFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const profiles = obj["profiles"];
  if (typeof profiles !== "object" || profiles === null) return false;
  for (const profile of Object.values(profiles)) {
    if (!isAuthProfile(profile)) return false;
  }
  return true;
}

export const getAuthFilePath = () => authFilePath();

const loadAuthFileFromPath = (filePath: string): AuthFile => {
  if (!existsSync(filePath)) return emptyAuthFile();
  if (!lstatSync(filePath).isFile()) return emptyAuthFile();

  const content = readFileSync(filePath, "utf8");
  if (content.trim().length === 0) return emptyAuthFile();

  // `auth.jsonc` tolerates comments and trailing commas (jsonc-parser),
  // unlike the strict `JSON.parse` this replaced — any other parse error
  // still falls back to an empty file, same as before.
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(content, errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) return emptyAuthFile();
  if (!isAuthFile(parsed)) return emptyAuthFile();
  return parsed;
};

export const loadAuthFile = (): AuthFile => {
  migrateLegacyConfigIfNeeded({
    authFileExists: () => existsSync(authFilePath()),
    configFileExists: () => existsSync(configFilePath()),
    writeAuthFile: (profiles) => {
      writeJsonFileAtomically(authFilePath(), { profiles });
    },
    writeConfigFile: (fields) => {
      writeJsonFileAtomically(configFilePath(), {
        ...fields,
        artifacts: MIGRATION_DEFAULT_ARTIFACT_RETENTION,
      });
    },
  });

  return loadAuthFileFromPath(authFilePath());
};

const writeAuthFile = (data: AuthFile) => {
  writeJsonFileAtomically(authFilePath(), data);
};

export const loadAuthProfile = (baseUrl: string): AuthProfile | null => {
  const authFile = loadAuthFile();
  return authFile.profiles[baseUrl] ?? null;
};

export const saveAuthProfile = (baseUrl: string, profile: AuthProfile) => {
  const authFile = loadAuthFile();
  authFile.profiles[baseUrl] = profile;
  writeAuthFile(authFile);
};

export const deleteAuthProfile = (baseUrl: string) => {
  const authFile = loadAuthFile();
  if (!(baseUrl in authFile.profiles)) return;

  const remainingProfiles = Object.fromEntries(
    Object.entries(authFile.profiles).filter(
      ([profileBaseUrl]) => profileBaseUrl !== baseUrl,
    ),
  );

  if (Object.keys(remainingProfiles).length === 0) {
    // Legacy-file cleanup used to happen here too, but `loadAuthFile()`
    // above already ran `migrateLegacyConfigIfNeeded`, which deletes any
    // legacy `.boboddy`/`.boboddy.json` the first time either new file is
    // read — by the time we get here that file is already gone, so a
    // second removal attempt would be dead code.
    rmSync(authFilePath(), { force: true });
    return;
  }

  writeAuthFile({ profiles: remainingProfiles });
};
