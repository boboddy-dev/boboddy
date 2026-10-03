import type {
  GitCacheLogger,
  MirrorOutcome,
} from "../application/git-mirror-cache";
import { normaliseGitUrl } from "../domain/git-mirror-key";

export const GIT_CACHE_LOG_SCOPE = "git-cache";

const USERINFO_IN_URL = /(:\/\/)[^/@\s'"]*@/g;

/** Logs the visible "the cache did not serve this clone" line. */
export function logCacheFallback(
  logger: GitCacheLogger | undefined,
  reason: string,
): void {
  logger?.log(
    GIT_CACHE_LOG_SCOPE,
    `git-cache: falling back to plain clone (${reason})`,
  );
}

/**
 * Timing lines. They go through `log` (info) so the default
 * `BOBODDY_LOG_SHIP_LEVEL` ships them, and carry no URL: only a duration and a
 * hit/miss/fallback marker.
 */
export function logMirrorPrepared(
  logger: GitCacheLogger | undefined,
  outcome: MirrorOutcome,
  elapsed: string,
): void {
  const action = outcome === "hit" ? "refreshed" : "created";
  logger?.log(
    GIT_CACHE_LOG_SCOPE,
    `git-cache: mirror ${action} in ${elapsed} (${outcome})`,
  );
}

export function logLocalClone(
  logger: GitCacheLogger | undefined,
  elapsed: string,
): void {
  logger?.log(GIT_CACHE_LOG_SCOPE, `git-cache: local clone in ${elapsed}`);
}

export function logFallbackClone(
  logger: GitCacheLogger | undefined,
  elapsed: string,
): void {
  logger?.log(
    GIT_CACHE_LOG_SCOPE,
    `git-cache: plain clone in ${elapsed} (fallback)`,
  );
}

/**
 * Git error output quotes the remote URL, userinfo included. Replace the raw
 * URL with its normalised form and strip any remaining `scheme://userinfo@`.
 */
export function redactGitUrl(text: string, rawUrl: string): string {
  const normalised = normaliseGitUrl(rawUrl) ?? "<remote>";
  return text
    .split(rawUrl.trim())
    .join(normalised)
    .replace(USERINFO_IN_URL, "$1");
}
