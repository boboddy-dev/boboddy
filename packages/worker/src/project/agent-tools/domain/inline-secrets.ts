/**
 * The heuristic for "this literal looks like a credential", used so discovery
 * never retains a secret value a repo committed into an MCP config.
 *
 * The literal is the value with every `{env:VAR}` placeholder removed and a
 * leading auth scheme (`Bearer`, `Basic`, `Token`) stripped. It is a secret
 * when either:
 *
 *   - it has a well-known token shape: OpenAI/Anthropic `sk-…`, Stripe
 *     `sk_live_…`/`rk_test_…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox?-…`,
 *     GitLab `glpat-…`, AWS `AKIA…`, Google `AIza…`, npm `npm_…`, Linear
 *     `lin_api_…`, Sentry `sntrys_…`, a JWT, or a URL carrying a password; or
 *   - its key reads like a credential and the literal is at least 8
 *     characters with no whitespace and is not a path. The key (lowercased,
 *     non-alphanumerics removed) reads like a credential when it ends in
 *     `token`, `secret`, `password`, `passwd`, `pwd`, `key` (but not
 *     `publickey`), `credential(s)`, `cookie`, `dsn`, `auth`,
 *     `authorization`, `sessionid` or `pat` — e.g. `GITHUB_TOKEN`,
 *     `X-Api-Key`, `Authorization`, `DB_PASSWORD`, `SENTRY_DSN`.
 */

const SECRET_KEY_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "key",
  "credential",
  "credentials",
  "cookie",
  "dsn",
  "auth",
  "authorization",
  "sessionid",
  "pat",
] as const;

const TOKEN_VALUE_PATTERNS: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}/u,
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/u,
  /^gh[pousr]_[A-Za-z0-9]{20,}/u,
  /^github_pat_[A-Za-z0-9_]{20,}/u,
  /^xox[abposr]-[A-Za-z0-9-]{10,}/u,
  /^glpat-[A-Za-z0-9_-]{16,}/u,
  /^AKIA[0-9A-Z]{16}$/u,
  /^AIza[0-9A-Za-z_-]{30,}/u,
  /^npm_[A-Za-z0-9]{30,}/u,
  /^lin_api_[A-Za-z0-9]{20,}/u,
  /^sntrys_[A-Za-z0-9_=-]{20,}/u,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/u,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/iu,
];

const ENV_PLACEHOLDER_PATTERN = /\{env:[^}]*\}/gu;

const AUTH_SCHEME_PATTERN = /^(?:bearer|basic|token)\s+/iu;

const PATH_PATTERN = /^(?:\/|\.\.?\/|~|[A-Za-z]:\\)/u;

function literalPart(value: string): string {
  return value
    .replace(ENV_PLACEHOLDER_PATTERN, "")
    .trim()
    .replace(AUTH_SCHEME_PATTERN, "")
    .trim();
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (normalized.endsWith("publickey")) return false;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function looksLikeTokenValue(value: string): boolean {
  const literal = literalPart(value);
  return TOKEN_VALUE_PATTERNS.some((pattern) => pattern.test(literal));
}

/** True when `value`, stored under `key`, carries a literal credential. */
export function isInlineSecret(key: string, value: string): boolean {
  const literal = literalPart(value);
  if (literal.length === 0) return false;
  if (TOKEN_VALUE_PATTERNS.some((pattern) => pattern.test(literal))) {
    return true;
  }
  return (
    isSecretKey(key) &&
    literal.length >= 8 &&
    !/\s/u.test(literal) &&
    !PATH_PATTERN.test(literal) &&
    !/^https?:\/\//iu.test(literal)
  );
}

/**
 * Where a URL carries a literal credential (its userinfo password or a
 * credential-looking query parameter), or `null` when it looks clean.
 */
export function urlInlineSecret(url: string): string | null {
  if (looksLikeTokenValue(url)) return "url";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const [key, value] of parsed.searchParams) {
    if (isInlineSecret(key, value)) return `query parameter ${key}`;
  }
  return null;
}

/**
 * The flag of the first command argument carrying a literal credential —
 * `--token=abc…`, `--api-key abc…`, or a bare token-shaped argument — or
 * `null` when the command looks clean.
 */
export function commandInlineSecret(command: readonly string[]): string | null {
  for (const [index, arg] of command.entries()) {
    if (looksLikeTokenValue(arg)) return `argument ${String(index)}`;
    const assignment = /^--?([^=\s]+)=(.*)$/su.exec(arg);
    if (assignment !== null) {
      const [, flag = "", value = ""] = assignment;
      if (isInlineSecret(flag, value)) return `--${flag}`;
      continue;
    }
    const next = command[index + 1];
    if (
      /^--?[^=\s]+$/u.test(arg) &&
      next !== undefined &&
      !next.startsWith("-")
    ) {
      if (isInlineSecret(arg.replace(/^--?/u, ""), next)) return arg;
    }
  }
  return null;
}
