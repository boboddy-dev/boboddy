import { z } from "zod";
import type {
  AnyJsonObject,
  AnyJsonValue,
} from "../../../common/contracts/json";
import {
  collectEnvPlaceholderNames,
  openCodeResolvedMcpServerConfigSchema,
  type ResolvedOpenCodeMcpServerConfig,
} from "../../../common/contracts/opencode-mcp";
import type { InlineSecret, McpConfigFormat } from "./discovered-agent-tools";
import {
  commandInlineSecret,
  isInlineSecret,
  urlInlineSecret,
} from "./inline-secrets";

/**
 * Turns one server entry from any supported MCP config shape into an OpenCode
 * v2 `local`/`remote` definition that is safe to keep: every variable is a
 * `{env:VAR}` placeholder and no literal credential survives.
 *
 * Shapes:
 *
 *   - OpenCode (`opencode.json[c]`): v2 `mcp.servers.<name>` is validated
 *     as-is; v1 `mcp.<name>` is converted first (`enabled: false` →
 *     `disabled: true`, numeric `timeout` → `{ startup }`, camelCase OAuth keys
 *     → snake_case). v1 toggle-only entries (`{ enabled }` with no `type`)
 *     define no server.
 *   - Claude (`.mcp.json`) / Cursor (`.cursor/mcp.json`): `mcpServers.<name>`
 *     with `command` + `args` + `env` (stdio), or `url` + `headers` with
 *     `type: "http" | "sse"` (Cursor may omit `type`).
 *   - VS Code (`.vscode/mcp.json`): `servers.<name>`, same fields with
 *     `type: "stdio" | "http" | "sse"`. A server reading an `${input:…}`
 *     prompt cannot run unattended and is skipped.
 *   - Codex (`.codex/config.toml`): `[mcp_servers.<name>]` with `command` +
 *     `args` + `env` + `env_vars` + `cwd`, or `url` + `http_headers` +
 *     `env_http_headers` + `bearer_token_env_var`; `enabled`,
 *     `startup_timeout_sec` and `tool_timeout_sec` map to `disabled` and
 *     `timeout`.
 *
 * Variables: `${VAR}`, `${env:VAR}` and `${VAR:-default}` (the default is
 * dropped) become `{env:VAR}`; OpenCode's `{env:VAR}` is kept. In VS Code
 * and Cursor configs, editor variables such as `${workspaceFolder}` and
 * `${userHome}` have no runtime equivalent and skip the server, as does any
 * other `${…}` that is not an env var name.
 *
 * Inline secrets (see `inline-secrets.ts`): a credential-looking literal in
 * `environment`, `headers` or `oauth.client_secret` is removed and recorded
 * by key; one in the command or URL cannot be removed cleanly, so the server
 * is skipped.
 */

export type NormalizedMcpServer =
  | {
      kind: "server";
      config: ResolvedOpenCodeMcpServerConfig;
      requiredEnv: string[];
      inlineSecrets: InlineSecret[];
    }
  | { kind: "skipped"; reason: string }
  | { kind: "not-a-definition" };

type JsonObject = Readonly<AnyJsonObject>;

type Candidate = AnyJsonObject;

type FormatResult =
  | { kind: "candidate"; candidate: Candidate }
  | { kind: "skipped"; reason: string }
  | { kind: "not-a-definition" };

function asObject(value: AnyJsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function skipped(reason: string): FormatResult {
  return { kind: "skipped", reason };
}

const V1_OAUTH_KEYS: Readonly<Record<string, string>> = {
  clientId: "client_id",
  clientSecret: "client_secret",
  callbackPort: "callback_port",
  redirectUri: "redirect_uri",
};

function convertV1OAuth(oauth: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(oauth).map(([key, value]) => [
      V1_OAUTH_KEYS[key] ?? key,
      value,
    ]),
  );
}

function fromOpencodeV1(entry: JsonObject): FormatResult {
  if (entry["type"] === undefined) return { kind: "not-a-definition" };

  const { enabled, timeout, oauth, ...rest } = entry;
  const converted: Candidate = { ...rest };
  if (enabled === false) converted["disabled"] = true;
  else if (enabled !== true && enabled !== undefined) {
    converted["enabled"] = enabled;
  }
  if (typeof timeout === "number") converted["timeout"] = { startup: timeout };
  else if (timeout !== undefined) converted["timeout"] = timeout;
  if (oauth !== undefined) {
    const oauthObject = asObject(oauth);
    converted["oauth"] = oauthObject ? convertV1OAuth(oauthObject) : oauth;
  }
  return { kind: "candidate", candidate: converted };
}

function stringArray(value: AnyJsonValue | undefined): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.every((item): item is string => typeof item === "string")
    ? value
    : null;
}

function stringMap(
  value: AnyJsonValue | undefined,
): Record<string, string> | null {
  if (value === undefined) return {};
  const object = asObject(value);
  if (object === null) return null;
  const map: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== "string") return null;
    map[key] = item;
  }
  return map;
}

function withNonEmpty(
  candidate: Candidate,
  key: string,
  map: Record<string, string>,
): Candidate {
  return Object.keys(map).length > 0 ? { ...candidate, [key]: map } : candidate;
}

/** Claude, Cursor and VS Code share one entry shape. */
function fromMcpJson(entry: JsonObject, format: McpConfigFormat): FormatResult {
  if (entry["envFile"] !== undefined)
    return skipped("envFile is not supported");
  if (entry["headersHelper"] !== undefined) {
    return skipped("headersHelper is not supported");
  }

  const type = entry["type"];
  const isStdio =
    type === "stdio" || (type === undefined && entry["command"] !== undefined);
  const isRemote =
    type === "http" ||
    type === "sse" ||
    type === "streamable-http" ||
    (type === undefined && entry["url"] !== undefined);

  if (isStdio) {
    const command = entry["command"];
    const args = stringArray(entry["args"]);
    const env = stringMap(entry["env"]);
    if (typeof command !== "string" || command.trim() === "") {
      return skipped("stdio server has no command");
    }
    if (args === null) return skipped("args must be an array of strings");
    if (env === null) return skipped("env must map names to strings");
    let candidate: Candidate = { type: "local", command: [command, ...args] };
    if (typeof entry["cwd"] === "string") candidate["cwd"] = entry["cwd"];
    candidate = withNonEmpty(candidate, "environment", env);
    if (entry["disabled"] === true) candidate["disabled"] = true;
    return { kind: "candidate", candidate };
  }

  if (isRemote) {
    const url = entry["url"];
    const headers = stringMap(entry["headers"]);
    if (typeof url !== "string" || url.trim() === "") {
      return skipped(
        `${typeof type === "string" ? type : "remote"} server has no url`,
      );
    }
    if (headers === null) return skipped("headers must map names to strings");
    let candidate: Candidate = { type: "remote", url };
    candidate = withNonEmpty(candidate, "headers", headers);
    const oauth = format === "claude" ? asObject(entry["oauth"]) : null;
    if (oauth !== null) {
      const converted: Candidate = {};
      if (typeof oauth["clientId"] === "string") {
        converted["client_id"] = oauth["clientId"];
      }
      if (typeof oauth["callbackPort"] === "number") {
        converted["callback_port"] = oauth["callbackPort"];
      }
      if (Object.keys(converted).length > 0) candidate["oauth"] = converted;
    }
    if (entry["disabled"] === true) candidate["disabled"] = true;
    return { kind: "candidate", candidate };
  }

  return skipped(
    type === undefined
      ? "server has neither a command nor a url"
      : `unsupported transport ${JSON.stringify(type)}`,
  );
}

function secondsToMs(value: AnyJsonValue | undefined): number | undefined {
  return typeof value === "number" && value > 0
    ? Math.round(value * 1000)
    : undefined;
}

function fromCodex(entry: JsonObject): FormatResult {
  if (entry["http_headers_helper"] !== undefined) {
    return skipped("http_headers_helper is not supported");
  }

  const timeout: Record<string, number> = {};
  const startup = secondsToMs(entry["startup_timeout_sec"]);
  const execution = secondsToMs(entry["tool_timeout_sec"]);
  if (startup !== undefined) timeout["startup"] = startup;
  if (execution !== undefined) timeout["execution"] = execution;
  const shared: Candidate = {};
  if (entry["enabled"] === false) shared["disabled"] = true;
  if (Object.keys(timeout).length > 0) shared["timeout"] = timeout;

  if (entry["command"] !== undefined) {
    const command = entry["command"];
    const args = stringArray(entry["args"]);
    const env = stringMap(entry["env"]);
    if (typeof command !== "string" || command.trim() === "") {
      return skipped("command must be a non-empty string");
    }
    if (args === null) return skipped("args must be an array of strings");
    if (env === null) return skipped("env must map names to strings");
    const forwarded = Array.isArray(entry["env_vars"]) ? entry["env_vars"] : [];
    for (const item of forwarded) {
      const named = asObject(item)?.["name"];
      const name =
        typeof item === "string"
          ? item
          : typeof named === "string"
            ? named
            : null;
      if (name === null)
        return skipped("env_vars entries must name a variable");
      env[name] ??= `{env:${name}}`;
    }
    let candidate: Candidate = { type: "local", command: [command, ...args] };
    if (typeof entry["cwd"] === "string") candidate["cwd"] = entry["cwd"];
    candidate = withNonEmpty(candidate, "environment", env);
    return { kind: "candidate", candidate: { ...candidate, ...shared } };
  }

  if (entry["url"] !== undefined) {
    const url = entry["url"];
    const headers = stringMap(entry["http_headers"]);
    const envHeaders = stringMap(entry["env_http_headers"]);
    if (typeof url !== "string" || url.trim() === "") {
      return skipped("url must be a non-empty string");
    }
    if (headers === null || envHeaders === null) {
      return skipped("headers must map names to strings");
    }
    for (const [header, variable] of Object.entries(envHeaders)) {
      headers[header] = `{env:${variable}}`;
    }
    const bearer = entry["bearer_token_env_var"];
    if (typeof bearer === "string" && bearer !== "") {
      headers["Authorization"] = `Bearer {env:${bearer}}`;
    }
    const candidate = withNonEmpty({ type: "remote", url }, "headers", headers);
    return { kind: "candidate", candidate: { ...candidate, ...shared } };
  }

  return skipped("server has neither a command nor a url");
}

function fromFormat(
  format: McpConfigFormat,
  entry: AnyJsonValue,
): FormatResult {
  const object = asObject(entry);
  if (object === null) return skipped("entry is not an object");
  switch (format) {
    case "opencode":
      return { kind: "candidate", candidate: { ...object } };
    case "claude":
    case "cursor":
    case "vscode":
      return fromMcpJson(object, format);
    case "codex":
      return fromCodex(object);
  }
}

const SHELL_VARIABLE_PATTERN = /\$\{([^}]*)\}/gu;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Editor-predefined `${name}` variables in VS Code and Cursor configs. */
const EDITOR_VARIABLES = new Set([
  "workspaceFolder",
  "workspaceFolderBasename",
  "workspaceRoot",
  "userHome",
  "cwd",
  "file",
  "fileBasename",
  "fileDirname",
  "fileExtname",
  "relativeFile",
  "pathSeparator",
  "/",
]);

class UnsupportedVariableError extends Error {}

function variableConverter(format: McpConfigFormat) {
  const editor = format === "vscode" || format === "cursor";
  return (value: string): string =>
    value.replace(SHELL_VARIABLE_PATTERN, (match, inner: string) => {
      if (inner.startsWith("input:")) {
        throw new UnsupportedVariableError("uses VS Code inputs prompts");
      }
      const isEnvPrefixed = inner.startsWith("env:");
      const name = isEnvPrefixed
        ? inner.slice("env:".length)
        : (inner.split(":-")[0] ?? "");
      const editorVariable =
        editor && !isEnvPrefixed && EDITOR_VARIABLES.has(name);
      if (ENV_NAME_PATTERN.test(name) && !editorVariable) {
        return `{env:${name}}`;
      }
      throw new UnsupportedVariableError(`unsupported variable ${match}`);
    });
}

function mapStrings(
  value: AnyJsonValue,
  convert: (text: string) => string,
): AnyJsonValue {
  if (typeof value === "string") return convert(value);
  if (Array.isArray(value))
    return value.map((item) => mapStrings(item, convert));
  const object = asObject(value);
  return object === null ? value : mapObjectStrings(object, convert);
}

function mapObjectStrings(
  object: JsonObject,
  convert: (text: string) => string,
): AnyJsonObject {
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      mapStrings(item, convert),
    ]),
  );
}

function without(candidate: Candidate, field: string): Candidate {
  return Object.fromEntries(
    Object.entries(candidate).filter(([key]) => key !== field),
  );
}

function redactMap(
  candidate: Candidate,
  field: "environment" | "headers",
  secrets: InlineSecret[],
): Candidate {
  const map = asObject(candidate[field]);
  if (map === null) return candidate;
  const kept: AnyJsonObject = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string" && isInlineSecret(key, value)) {
      secrets.push({ field, key, inlineSecret: true });
    } else {
      kept[key] = value;
    }
  }
  return Object.keys(kept).length > 0
    ? { ...candidate, [field]: kept }
    : without(candidate, field);
}

function redactOAuthSecret(
  candidate: Candidate,
  secrets: InlineSecret[],
): Candidate {
  const oauth = asObject(candidate["oauth"]);
  const secret = oauth?.["client_secret"];
  if (oauth === null || typeof secret !== "string") return candidate;
  if (!isInlineSecret("client_secret", secret)) return candidate;
  secrets.push({ field: "oauth", key: "client_secret", inlineSecret: true });
  return { ...candidate, oauth: without({ ...oauth }, "client_secret") };
}

/**
 * The reason a candidate carries a credential discovery cannot strip — one
 * in the command or URL — or `null`.
 */
function unremovableSecret(candidate: Candidate): string | null {
  const command = stringArray(candidate["command"]);
  const fromCommand = command === null ? null : commandInlineSecret(command);
  if (fromCommand !== null) return `inline secret in command (${fromCommand})`;
  const url = candidate["url"];
  const fromUrl = typeof url === "string" ? urlInlineSecret(url) : null;
  if (fromUrl !== null) return `inline secret in url (${fromUrl})`;
  return null;
}

/**
 * Normalize one entry. `generation` applies to the OpenCode format only and
 * selects v1 conversion.
 */
export function normalizeMcpServer(input: {
  format: McpConfigFormat;
  entry: AnyJsonValue;
  generation?: "v1" | "v2";
}): NormalizedMcpServer {
  const v1 =
    input.format === "opencode" && input.generation === "v1"
      ? asObject(input.entry)
      : null;
  const result = v1
    ? fromOpencodeV1(v1)
    : fromFormat(input.format, input.entry);
  if (result.kind !== "candidate") return result;

  let candidate: Candidate;
  try {
    candidate = mapObjectStrings(
      result.candidate,
      variableConverter(input.format),
    );
  } catch (error) {
    if (error instanceof UnsupportedVariableError) {
      return { kind: "skipped", reason: error.message };
    }
    throw error;
  }

  const unremovable = unremovableSecret(candidate);
  if (unremovable !== null) return { kind: "skipped", reason: unremovable };

  const inlineSecrets: InlineSecret[] = [];
  candidate = redactMap(candidate, "environment", inlineSecrets);
  candidate = redactMap(candidate, "headers", inlineSecrets);
  candidate = redactOAuthSecret(candidate, inlineSecrets);

  const parsed = openCodeResolvedMcpServerConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      kind: "skipped",
      reason: `invalid server: ${z.prettifyError(parsed.error)}`,
    };
  }

  return {
    kind: "server",
    config: parsed.data,
    requiredEnv: collectEnvPlaceholderNames(parsed.data),
    inlineSecrets,
  };
}
