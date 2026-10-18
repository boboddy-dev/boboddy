import path from "node:path";
import { createBoboddyClient } from "../client";
import { loadAuthProfile } from "./auth-file";
import { resolveBoboddyBaseUrl } from "./base-url";
import { loadProjectConfig } from "./project-config";
import { resolveProjectRef } from "./project-ref";

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
 * - `accessToken`: from `BOBODDY_ACCESS_TOKEN` env var or the saved auth
 *   profile for the resolved `baseUrl`.
 * - `projectId`: from `BOBODDY_PROJECT_ID` env var (a project id, which
 *   `boboddy pipelines push` sets after resolving the ref), or else the
 *   `"project"` ref in the nearest ancestor `.boboddy/boboddy.jsonc` of
 *   `opts.dir`, resolved against the server. Resolution needs `accessToken`;
 *   without one `projectId` is left undefined. A ref the server rejects throws
 *   a `ProjectRefError` naming the ref.
 */
export async function loadPushDefaults(
  opts: LoadPushDefaultsOptions,
): Promise<PushDefaults> {
  const baseUrl = resolveBoboddyBaseUrl();

  const envAccessToken = process.env["BOBODDY_ACCESS_TOKEN"]?.trim();
  const accessToken = envAccessToken
    ? envAccessToken
    : loadAuthProfile(baseUrl)?.accessToken;

  const envProjectId = process.env["BOBODDY_PROJECT_ID"]?.trim();
  if (envProjectId) {
    return { baseUrl, projectId: envProjectId, accessToken };
  }

  const config = await findProjectConfigUpwards(opts.dir);
  if (!config || !accessToken) {
    return { baseUrl, projectId: undefined, accessToken };
  }

  const resolved = await resolveProjectRef(
    createBoboddyClient(baseUrl),
    config.project,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      action: "push pipelines to",
    },
  );
  return { baseUrl, projectId: resolved.id, accessToken };
}
