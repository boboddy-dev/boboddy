/**
 * Detects which supported repo host a git remote URL points at. No `node:`
 * imports: Next client components use this module.
 *
 * Only `github.com/<owner>/<name>` and `bitbucket.org/<workspace>/<slug>` on
 * the default port are recognised; every other remote, local path or
 * unparseable string is `other`. Path segments keep the casing the URL uses.
 */

import { hasDefaultPort, normalisePath, parseRemote } from "./git-remote";

export type GitHost =
  | { host: "github"; owner: string; name: string; webUrl: string }
  | { host: "bitbucket"; workspace: string; slug: string; webUrl: string }
  | { host: "other" };

export type GitHostKind = GitHost["host"];

const OTHER: GitHost = { host: "other" };

export function parseGitHost(rawUrl: string): GitHost {
  const parsed = parseRemote(rawUrl);
  if (parsed === null || !hasDefaultPort(parsed)) {
    return OTHER;
  }
  const segments = normalisePath(parsed.path).split("/");
  if (segments.length !== 2) {
    return OTHER;
  }
  const [first = "", second = ""] = segments;
  if (first === "" || second === "") {
    return OTHER;
  }
  switch (parsed.host) {
    case "github.com":
      return {
        host: "github",
        owner: first,
        name: second,
        webUrl: `https://github.com/${first}/${second}`,
      };
    case "bitbucket.org":
      return {
        host: "bitbucket",
        workspace: first,
        slug: second,
        webUrl: `https://bitbucket.org/${first}/${second}`,
      };
    default:
      return OTHER;
  }
}
