import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface AuthProfile {
  accessToken: string;
  userId?: string;
  email?: string;
  name?: string;
}

export interface AuthFile {
  profiles: Record<string, AuthProfile>;
  /**
   * A random id generated on first read and persisted here, alongside (not
   * inside) any per-baseUrl profile — it identifies this machine/install
   * before any account exists, so pre-auth CLI telemetry (init started,
   * requirements verified) has a stable distinct id to key events to. See
   * `getOrCreateAnonymousId`.
   */
  anonymousId?: string;
  /**
   * User-level telemetry opt-out, set via `boboddy telemetry disable` (or the
   * `BOBODDY_TELEMETRY_DISABLED` env var, checked separately at the call
   * site). Global — unlike `profiles`, it is not scoped to a `baseUrl`.
   */
  telemetryDisabled?: boolean;
}

// Test-only escape hatch. `os.homedir()` is resolved by the runtime at ITS
// OWN startup (confirmed against Bun: mutating `process.env.HOME` or
// `process.env.USERPROFILE` afterward, or mocking `node:os`, does NOT change
// what `homedir()` returns), so there is no reliable way to redirect this
// module at a scratch directory from within a running test process other
// than this explicit hook. Anything that changes this file's read/write path
// MUST go through here, never through env vars — an unreliable override is
// worse than none: it silently falls through to the developer's real
// `~/.boboddy.json` instead of failing loudly.
let homeDirOverrideForTests: string | undefined;

/** Test-only. Redirects every read/write in this module under `dir`. */
export function setHomeDirForTests(dir: string | undefined): void {
  homeDirOverrideForTests = dir;
}

const resolveHomeDir = () => homeDirOverrideForTests ?? homedir();
const legacyAuthFilePath = () => join(resolveHomeDir(), ".boboddy");
const authFilePath = () => join(resolveHomeDir(), ".boboddy.json");

const EMPTY_AUTH_FILE: AuthFile = {
  profiles: {},
};

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
  return true;
}

const ensureFilePermissions = (filePath: string) => {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only; some platforms may not support chmod semantics.
  }
};

export const getAuthFilePath = () => authFilePath();

const loadAuthFileFromPath = (filePath: string): AuthFile => {
  if (!existsSync(filePath)) return EMPTY_AUTH_FILE;
  if (!lstatSync(filePath).isFile()) return EMPTY_AUTH_FILE;

  const content = readFileSync(filePath, "utf8");
  if (content.trim().length === 0) return EMPTY_AUTH_FILE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY_AUTH_FILE;
  }
  if (!isAuthFile(parsed)) return EMPTY_AUTH_FILE;
  return parsed;
};

export const loadAuthFile = (): AuthFile => {
  const authFile = authFilePath();
  if (existsSync(authFile)) {
    return loadAuthFileFromPath(authFile);
  }
  return loadAuthFileFromPath(legacyAuthFilePath());
};

const writeAuthFile = (data: AuthFile) => {
  const authFile = authFilePath();
  const parentDirectory = dirname(authFile);
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true });
  }

  const temporaryPath = `${authFile}.${String(process.pid)}.${String(Date.now())}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  ensureFilePermissions(temporaryPath);
  renameSync(temporaryPath, authFile);
  ensureFilePermissions(authFile);
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
    rmSync(authFilePath(), { force: true });
    const legacyPath = legacyAuthFilePath();
    if (existsSync(legacyPath) && lstatSync(legacyPath).isFile()) {
      rmSync(legacyPath, { force: true });
    }
    return;
  }

  writeAuthFile({ profiles: remainingProfiles });
};

/**
 * The persisted pre-auth distinct id for this machine/install, creating and
 * persisting one the first time it is read. Stable across every command
 * invocation until `~/.boboddy.json` is deleted (e.g. by `boboddy auth
 * logout` clearing the last profile — see `deleteAuthProfile` above, which
 * only removes the file once no profiles remain; a bare id-only file is left
 * alone by that path since it always re-reads via `loadAuthFile`).
 */
export const getOrCreateAnonymousId = (): string => {
  const authFile = loadAuthFile();
  if (authFile.anonymousId) return authFile.anonymousId;

  const anonymousId = randomUUID();
  writeAuthFile({ ...authFile, anonymousId });
  return anonymousId;
};

/** The persisted telemetry opt-out flag. Defaults to `false` (enabled). */
export const isTelemetryDisabled = (): boolean =>
  loadAuthFile().telemetryDisabled === true;

/** Persist the telemetry opt-out flag, leaving profiles/anonymousId intact. */
export const setTelemetryDisabled = (disabled: boolean): void => {
  const authFile = loadAuthFile();
  writeAuthFile({ ...authFile, telemetryDisabled: disabled });
};
