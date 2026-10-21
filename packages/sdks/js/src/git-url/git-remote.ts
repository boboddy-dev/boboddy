/**
 * Internal remote-URL parsing shared by the `git-url` helpers. Not exported
 * from the SDK entry. No `node:` imports: Next client components use it.
 *
 * Scp form (`git@host:path`), `ssh://`, `git+ssh://`, `ssh+git://`, `git://`,
 * `http://` and `https://` are accepted; local paths, `file://` and anything
 * else unrecognised yield `null`. The host is lowercased; the path is kept
 * verbatim apart from dropping any query and fragment.
 *
 * Parsing follows `packages/worker/src/runtime/runtime-service/domain/git-mirror-key.ts`,
 * which deliberately keeps the scheme and is not shared.
 */

export const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  http: "80",
  https: "443",
  ssh: "22",
  "git+ssh": "22",
  "ssh+git": "22",
  git: "9418",
};

const URL_FORM = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/s;
const SCP_FORM = /^(?:([^@/:\s]+)@)?([^@/:\s[\]]+):(?!:)(.+)$/;
const HOST_PORT = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d*))?$/;

export type ParsedRemote = {
  scheme: string;
  host: string;
  port: string | null;
  path: string;
};

export type UrlFormParts = {
  scheme: string;
  prefix: string;
  userinfo: string | null;
  hostPort: string;
  remainder: string;
};

export function parseRemote(rawUrl: string): ParsedRemote | null {
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

export function hasDefaultPort(remote: ParsedRemote): boolean {
  return remote.port === null || remote.port === DEFAULT_PORTS[remote.scheme];
}

export function splitUrlForm(value: string): UrlFormParts | null {
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

export function normalisePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
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
