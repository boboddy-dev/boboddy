import path from "node:path";
import { loadAuthProfile } from "./auth-file";
import { resolveBoboddyBaseUrl } from "./base-url";
import { loadProjectConfig } from "./project-config";

export interface PushDefaults {
  baseUrl: string;
  projectId: string | undefined;
  accessToken: string | undefined;
}

export interface LoadPushDefaultsOptions {
  /**
   * Directory the script is running from. The project config (`.boboddy/boboddy.jsonc`)
   * is searched for in this directory and each ancestor directory.
   */
  dir: string;
}

async function findProjectConfigUpwards(startDir: string) {
  let current = path.resolve(startDir);
  for (;;) {
    const found = await loadProjectConfig(current);
    if (found) return found;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Reads the conventional defaults for a `boboddy pipelines push` run:
 * - `baseUrl`: from `BOBODDY_BASE_URL` env var or the built-in default.
 * - `projectId`: from `BOBODDY_PROJECT_ID` env var or the nearest ancestor
 *   `.boboddy/boboddy.jsonc` of `opts.dir`.
 * - `accessToken`: from `BOBODDY_ACCESS_TOKEN` env var or the saved auth
 *   profile for the resolved `baseUrl`.
 */
export async function loadPushDefaults(
  opts: LoadPushDefaultsOptions,
): Promise<PushDefaults> {
  const baseUrl = resolveBoboddyBaseUrl();

  const envProjectId = process.env["BOBODDY_PROJECT_ID"]?.trim();
  const projectId = envProjectId
    ? envProjectId
    : (await findProjectConfigUpwards(opts.dir))?.projectId;

  const envAccessToken = process.env["BOBODDY_ACCESS_TOKEN"]?.trim();
  const accessToken = envAccessToken
    ? envAccessToken
    : loadAuthProfile(baseUrl)?.accessToken;

  return { baseUrl, projectId, accessToken };
}
