import type { Logger } from "@boboddy/observability/logging/host";
import type { GitCloneService } from "../application/git-clone-service";
import { CachedGitCloneService } from "./cached-git-clone-service";
import { resolveGitCacheConfig } from "./git-cache-config";
import { GitCliCloneService } from "./git-cli-clone-service";
import { GitCliMirrorCache } from "./git-cli-mirror-cache";

type Env = Record<string, string | undefined>;

export type GitCloneServiceSetup = {
  gitCloneService: GitCloneService;
  /** The resolved mirror cache dir, or `null` when the cache is off. */
  cacheDir: string | null;
};

/**
 * Builds the clone service from the env map: the plain `GitCliCloneService`
 * when `BOBODDY_GIT_CACHE=off`, otherwise a `CachedGitCloneService` over a
 * `GitCliMirrorCache` that falls back to that plain service. Also returns the
 * resolved cache dir so callers can export it. Throws a `ConfigurationError`
 * for an invalid cache setting.
 */
export function createGitCloneService(
  env: Env,
  logger: Logger,
): GitCloneServiceSetup {
  const config = resolveGitCacheConfig(env);
  const plain = new GitCliCloneService(logger);
  if (!config.enabled) {
    return { gitCloneService: plain, cacheDir: null };
  }
  return {
    gitCloneService: new CachedGitCloneService({
      cache: new GitCliMirrorCache({ cacheDir: config.cacheDir }),
      fallback: plain,
    }),
    cacheDir: config.cacheDir,
  };
}
