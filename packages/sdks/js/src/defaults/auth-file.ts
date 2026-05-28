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

export interface AuthProfile {
  accessToken: string;
  userId?: string;
  email?: string;
  name?: string;
}

export interface AuthFile {
  profiles: Record<string, AuthProfile>;
}

const LEGACY_AUTH_FILE_PATH = join(homedir(), ".boboddy");
const AUTH_FILE_PATH = join(homedir(), ".boboddy.json");

const EMPTY_AUTH_FILE: AuthFile = {
  profiles: {},
};

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

function isAuthFile(value: unknown): value is AuthFile {
  if (typeof value !== "object" || value === null) return false;
  const profiles = (value as Record<string, unknown>)["profiles"];
  if (typeof profiles !== "object" || profiles === null) return false;
  for (const profile of Object.values(profiles)) {
    if (!isAuthProfile(profile)) return false;
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

export const getAuthFilePath = () => AUTH_FILE_PATH;

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
  if (existsSync(AUTH_FILE_PATH)) {
    return loadAuthFileFromPath(AUTH_FILE_PATH);
  }
  return loadAuthFileFromPath(LEGACY_AUTH_FILE_PATH);
};

const writeAuthFile = (data: AuthFile) => {
  const parentDirectory = dirname(AUTH_FILE_PATH);
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true });
  }

  const temporaryPath = `${AUTH_FILE_PATH}.${String(process.pid)}.${String(Date.now())}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(data, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  ensureFilePermissions(temporaryPath);
  renameSync(temporaryPath, AUTH_FILE_PATH);
  ensureFilePermissions(AUTH_FILE_PATH);
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
    rmSync(AUTH_FILE_PATH, { force: true });
    if (
      existsSync(LEGACY_AUTH_FILE_PATH) &&
      lstatSync(LEGACY_AUTH_FILE_PATH).isFile()
    ) {
      rmSync(LEGACY_AUTH_FILE_PATH, { force: true });
    }
    return;
  }

  writeAuthFile({ profiles: remainingProfiles });
};
