import { createHash } from "node:crypto";

/**
 * Pure helpers that derive the git mirror cache key for a remote URL.
 *
 * Normalisation (applied before hashing; mirrored in `docs/architecture.md`):
 *  1. `scheme://[userinfo@]host[:port]/path` is parsed as a URL. SCP-style
 *     `[user@]host:path` becomes `ssh://host/path`. An absolute local path
 *     becomes `file://<path>`. Anything else (relative paths, unsupported
 *     schemes, git's `transport::address` forms) is not understood and yields
 *     `null`.
 *  2. Scheme and host are lowercased; userinfo, query and fragment are dropped.
 *  3. A trailing `/` and a trailing `.git` are stripped from the path.
 *  4. Scheme and port are kept, so `https://host/x` and `ssh://host/x` do not
 *     share a mirror. Path case is preserved.
 *  5. `key = sha256(normalised).hex.slice(0, 16)`.
 *
 * Credentials never reach the normalised form or the key. A URL that carries a
 * password or token in its userinfo is additionally reported as not cacheable
 * by {@link isCacheableUrl} so the caller falls back to a plain clone and never
 * needs a credential on disk or on a `git fetch` command line.
 */

const SUPPORTED_SCHEMES = new Set(["http", "https", "ssh", "git", "file"]);

const URL_FORM = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/;
const SCP_FORM = /^(?:([^@/:\s]+)@)?([^@/:\s[\]]+):(?!:)(.+)$/;
const HOST_PORT = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d*))?$/;

/**
 * Usernames GitHub, GitLab and friends actually issue are short and plain. A
 * longer or token-shaped string in the username slot of an `http(s)` URL is
 * treated as a credential (`https://ghp_...@github.com/...`).
 */
const PLAIN_HTTP_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;
const TOKEN_PREFIX =
  /^(gh[pousr]_|github_pat_|glpat-|glptt-|gldt-|glrt-|xox[a-z]-|npm_|akia|asia|sk-)/i;
const HEX_BLOB = /^[0-9a-f]{20,}$/i;
const PLAIN_SSH_USERNAME = /^[^:%@\s]+$/;

type ParsedGitUrl = {
  scheme: string;
  userinfo: string | null;
  host: string;
  port: string | null;
  path: string;
};

/**
 * Returns the normalised, userinfo-stripped form of `rawUrl`, or `null` when it
 * is not a URL form the cache understands (unsupported scheme, relative path,
 * missing host). Safe to log: it never contains userinfo.
 */
export function normaliseGitUrl(rawUrl: string): string | null {
  const parsed = parseGitUrl(rawUrl);
  if (!parsed) {
    return null;
  }
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.scheme}://${parsed.host}${port}${normalisePath(parsed.path)}`;
}

/**
 * Returns the 16-hex-char mirror key for `rawUrl`, or `null` when the URL
 * cannot be normalised. Equal for every spelling that normalises equal; never
 * derived from userinfo.
 */
export function mirrorKey(rawUrl: string): string | null {
  const normalised = normaliseGitUrl(rawUrl);
  if (normalised === null) {
    return null;
  }
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

/**
 * Whether `rawUrl` may be served from a mirror. False when the URL cannot be
 * normalised or its userinfo holds a credential:
 *  - any `:password` component (including an empty one);
 *  - percent-encoded or multi-`@` userinfo, which can hide a password;
 *  - for `http(s)`, a username that is not plain (longer than 39 characters,
 *    outside `[A-Za-z0-9._-]`, token-prefixed such as `ghp_`/`glpat-`, or a long
 *    hex blob).
 * A bare ssh-style username such as `git@` is fine.
 */
export function isCacheableUrl(rawUrl: string): boolean {
  const parsed = parseGitUrl(rawUrl);
  if (!parsed) {
    return false;
  }
  return !carriesCredential(parsed);
}

function carriesCredential(parsed: ParsedGitUrl): boolean {
  const userinfo = parsed.userinfo;
  if (userinfo === null || userinfo === "") {
    return false;
  }
  if (parsed.scheme === "http" || parsed.scheme === "https") {
    return !isPlainHttpUsername(userinfo);
  }
  return !PLAIN_SSH_USERNAME.test(userinfo);
}

function isPlainHttpUsername(userinfo: string): boolean {
  return (
    PLAIN_HTTP_USERNAME.test(userinfo) &&
    !TOKEN_PREFIX.test(userinfo) &&
    !HEX_BLOB.test(userinfo)
  );
}

function parseGitUrl(rawUrl: string): ParsedGitUrl | null {
  const trimmed = rawUrl.trim();
  if (trimmed === "") {
    return null;
  }
  const urlForm = URL_FORM.exec(trimmed);
  if (urlForm) {
    const [, scheme = "", rest = ""] = urlForm;
    return parseUrlForm(scheme.toLowerCase(), rest);
  }
  if (trimmed.startsWith("/")) {
    return {
      scheme: "file",
      userinfo: null,
      host: "",
      port: null,
      path: trimmed,
    };
  }
  return parseScpForm(trimmed);
}

function parseUrlForm(scheme: string, rest: string): ParsedGitUrl | null {
  if (!SUPPORTED_SCHEMES.has(scheme)) {
    return null;
  }
  const withoutQuery = rest.replace(/[#?].*$/s, "");
  const slash = withoutQuery.indexOf("/");
  const authority = slash === -1 ? withoutQuery : withoutQuery.slice(0, slash);
  const path = slash === -1 ? "" : withoutQuery.slice(slash);

  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? null : authority.slice(0, at);
  const hostPort = at === -1 ? authority : authority.slice(at + 1);

  if (hostPort === "") {
    return scheme === "file" && userinfo === null
      ? { scheme, userinfo, host: "", port: null, path }
      : null;
  }
  const match = HOST_PORT.exec(hostPort);
  if (!match) {
    return null;
  }
  const [, host = "", port = ""] = match;
  return {
    scheme,
    userinfo,
    host: host.toLowerCase(),
    port: port === "" ? null : port,
    path,
  };
}

function parseScpForm(value: string): ParsedGitUrl | null {
  const match = SCP_FORM.exec(value);
  if (!match) {
    return null;
  }
  const [, userinfo = null, host = "", path = ""] = match;
  return {
    scheme: "ssh",
    userinfo,
    host: host.toLowerCase(),
    port: null,
    path: `/${path.replace(/^\/+/, "")}`,
  };
}

function normalisePath(path: string): string {
  return path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}
