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
 *
 * Parsing follows `packages/worker/src/runtime/runtime-service/domain/git-mirror-key.ts`,
 * which deliberately keeps the scheme and is not shared.
 */

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  http: "80",
  https: "443",
  ssh: "22",
  "git+ssh": "22",
  "ssh+git": "22",
  git: "9418",
};

const HTTP_SCHEMES = new Set(["http", "https"]);
const CASE_INSENSITIVE_PATH_HOSTS = new Set(["github.com"]);

const URL_FORM = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/s;
const SCP_FORM = /^(?:([^@/:\s]+)@)?([^@/:\s[\]]+):(?!:)(.+)$/;
const HOST_PORT = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d*))?$/;

type ParsedRemote = {
  scheme: string;
  host: string;
  port: string | null;
  path: string;
};

type UrlFormParts = {
  scheme: string;
  prefix: string;
  userinfo: string | null;
  hostPort: string;
  remainder: string;
};

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
    parsed.port === null || parsed.port === DEFAULT_PORTS[parsed.scheme]
      ? ""
      : `:${parsed.port}`;
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
  const parsed = parseRemote(rawUrl);
  if (parsed === null || parsed.host !== "github.com") {
    return null;
  }
  if (parsed.port !== null && parsed.port !== DEFAULT_PORTS[parsed.scheme]) {
    return null;
  }
  const segments = normalisePath(parsed.path).split("/");
  if (segments.length !== 2) {
    return null;
  }
  const [owner = "", name = ""] = segments;
  if (owner === "" || name === "") {
    return null;
  }
  return { owner, name };
}

function parseRemote(rawUrl: string): ParsedRemote | null {
  const trimmed = rawUrl.trim();
  if (trimmed === "") {
    return null;
  }
  const urlForm = splitUrlForm(trimmed);
  if (urlForm !== null) {
    return parseUrlForm(urlForm);
  }
  if (URL_FORM.test(trimmed) || trimmed.startsWith("/")) {
    return null;
  }
  return parseScpForm(trimmed);
}

function splitUrlForm(value: string): UrlFormParts | null {
  const match = URL_FORM.exec(value);
  if (!match) {
    return null;
  }
  const [, rawScheme = "", rest = ""] = match;
  const scheme = rawScheme.toLowerCase();
  if (!(scheme in DEFAULT_PORTS)) {
    return null;
  }
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const remainder = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
  const at = authority.lastIndexOf("@");
  return {
    scheme,
    prefix: `${rawScheme}://`,
    userinfo: at === -1 ? null : authority.slice(0, at),
    hostPort: at === -1 ? authority : authority.slice(at + 1),
    remainder,
  };
}

function parseUrlForm(parts: UrlFormParts): ParsedRemote | null {
  const match = HOST_PORT.exec(parts.hostPort);
  if (!match) {
    return null;
  }
  const [, host = "", port = ""] = match;
  return {
    scheme: parts.scheme,
    host: host.toLowerCase(),
    port: port === "" ? null : port,
    path: parts.remainder.replace(/[?#].*$/s, ""),
  };
}

function parseScpForm(value: string): ParsedRemote | null {
  const match = SCP_FORM.exec(value);
  if (!match) {
    return null;
  }
  const [, , host = "", path = ""] = match;
  if (host.length === 1) {
    return null;
  }
  return { scheme: "ssh", host: host.toLowerCase(), port: null, path };
}

function normalisePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}
