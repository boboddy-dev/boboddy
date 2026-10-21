/**
 * Pure helpers for comparing and displaying git remote URLs. No `node:`
 * imports: Next client components use this module.
 *
 * A repository's **identity key** is `host[:port]/path`, so every spelling of
 * the same remote compares equal:
 *  - scp form (`git@host:path`), `ssh://`, `git+ssh://`, `ssh+git://`,
 *    `git://`, `http://` and `https://` are accepted;
 *  - the scheme, userinfo, query, fragment and default ports are dropped;
 *  - the host is lowercased, and a trailing `/` and `.git` are stripped;
 *  - the path is lowercased for `github.com` only, whose paths are
 *    case-insensitive;
 *  - local paths, `file://` and anything else unrecognised yield `null`.
 *
 * The identity key is for comparison only. A stored `gitUrl` is never
 * rewritten to it, because workers clone the stored URL verbatim.
 */

import {
  hasDefaultPort,
  normalisePath,
  parseRemote,
  splitUrlForm,
} from "./git-remote";
import { parseGitHost } from "./parse-git-host";

export { parseGitHost } from "./parse-git-host";
export type { GitHost, GitHostKind } from "./parse-git-host";

const HTTP_SCHEMES = new Set(["http", "https"]);
const CASE_INSENSITIVE_PATH_HOSTS = new Set(["github.com"]);

/**
 * The identity key for `rawUrl` (e.g. `"github.com/acme/repo"`), or `null`
 * when it is a local path, a `file://` URL, or not a recognised remote.
 */
export function gitRepoIdentity(rawUrl: string): string | null {
  const parsed = parseRemote(rawUrl);
  if (parsed === null) {
    return null;
  }
  const path = normalisePath(parsed.path);
  if (path === "") {
    return null;
  }
  const port =
    parsed.port === null || hasDefaultPort(parsed) ? "" : `:${parsed.port}`;
  const caseFoldedPath = CASE_INSENSITIVE_PATH_HOSTS.has(parsed.host)
    ? path.toLowerCase()
    : path;
  return `${parsed.host}${port}/${caseFoldedPath}`;
}

/**
 * Whether two remote URLs point at the same repository: their identity keys
 * match, or — when either has no identity key — the raw strings are equal.
 */
export function isSameGitRepo(a: string, b: string): boolean {
  const left = gitRepoIdentity(a);
  const right = gitRepoIdentity(b);
  if (left === null || right === null) {
    return a === b;
  }
  return left === right;
}

/**
 * `rawUrl` with any credential removed, safe to print or put in a link. For
 * `http(s)` the whole userinfo goes, since a bare username there is often a
 * token; for other URL schemes only a `:password` part goes, keeping an
 * ssh-style `git@`. Anything not in URL form is returned unchanged.
 */
export function stripGitUrlCredentials(rawUrl: string): string {
  const parts = splitUrlForm(rawUrl.trim());
  if (parts === null || parts.userinfo === null) {
    return rawUrl;
  }
  const keptUser = HTTP_SCHEMES.has(parts.scheme)
    ? ""
    : (parts.userinfo.split(":")[0] ?? "");
  const userPart = keptUser === "" ? "" : `${keptUser}@`;
  return `${parts.prefix}${userPart}${parts.hostPort}${parts.remainder}`;
}

/**
 * The GitHub `owner`/`name` of `rawUrl`, in the casing the URL uses, or `null`
 * when it is not a `github.com/<owner>/<name>` remote.
 */
export function parseGitHubRepo(
  rawUrl: string,
): { owner: string; name: string } | null {
  const repo = parseGitHost(rawUrl);
  return repo.host === "github" ? { owner: repo.owner, name: repo.name } : null;
}
