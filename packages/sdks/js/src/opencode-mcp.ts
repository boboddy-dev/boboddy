/**
 * Step-declared MCP servers, in OpenCode v2's native `mcp.servers.<name>` entry
 * shape, plus a Boboddy-only `ref` entry. The worker resolves refs before
 * passing the resulting `local`/`remote` entries to the runtime overlay, so
 * the `local`/`remote` schemas mirror the v2 config schema.
 * `test/opencode-config-shapes.test.ts` fails typecheck if they drift from
 * `@opencode/client`'s generated `ConfigEntry` type.
 */
import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

const mcpStringMapSchema = z.record(z.string(), z.string());

const positiveIntSchema = z.int().gt(0).max(Number.MAX_SAFE_INTEGER);

export const openCodeMcpTimeoutSchema = z
  .object({
    startup: positiveIntSchema.optional(),
    catalog: positiveIntSchema.optional(),
    execution: positiveIntSchema.optional(),
  })
  .strict();

export const openCodeMcpProtocolSchema = z.enum([
  "legacy",
  "auto",
  "2026-07-28",
]);

const sharedServerFields = {
  disabled: z.boolean().optional(),
  codemode: z.boolean().optional(),
  timeout: openCodeMcpTimeoutSchema.optional(),
  protocol: openCodeMcpProtocolSchema.optional(),
};

/** A `local` entry, exactly as OpenCode reads it. */
export const openCodeMcpLocalConfigSchema = z
  .object({
    type: z.literal("local"),
    command: z.array(nonEmptyStringSchema).min(1),
    cwd: z.string().optional(),
    environment: mcpStringMapSchema.optional(),
    ...sharedServerFields,
  })
  .strict();

export const openCodeMcpOAuthConfigSchema = z
  .object({
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    scope: z.string().optional(),
    callback_port: positiveIntSchema.optional(),
    redirect_uri: z.string().optional(),
    auth_server_metadata_url: z.string().optional(),
  })
  .strict();

/** A `remote` entry, exactly as OpenCode reads it. */
export const openCodeMcpRemoteConfigSchema = z
  .object({
    type: z.literal("remote"),
    url: z.string(),
    headers: mcpStringMapSchema.optional(),
    oauth: z.union([openCodeMcpOAuthConfigSchema, z.literal(false)]).optional(),
    ...sharedServerFields,
  })
  .strict();

/**
 * A reference to an MCP server defined in the repository's own MCP config
 * files (`.opencode/opencode.json`, `.mcp.json`, `.codex/config.toml`, …).
 * `name` defaults to the step's server key. The worker resolves refs into
 * `local`/`remote` entries before launch, applying the shared fields on top;
 * `name` is Boboddy-only and dropped during resolution, so a ref never reaches
 * OpenCode.
 */
export const openCodeMcpRefConfigSchema = z
  .object({
    type: z.literal("ref"),
    name: nonEmptyStringSchema.optional(),
    ...sharedServerFields,
  })
  .strict();

export const openCodeResolvedMcpServerConfigSchema = z.discriminatedUnion(
  "type",
  [openCodeMcpLocalConfigSchema, openCodeMcpRemoteConfigSchema],
);

export const openCodeResolvedMcpServersSchema = z.record(
  z.string(),
  openCodeResolvedMcpServerConfigSchema,
);

/** The authored/stored shape: `local`, `remote`, or an unresolved `ref`. */
export const openCodeMcpServerConfigSchema = z.discriminatedUnion("type", [
  openCodeMcpLocalConfigSchema,
  openCodeMcpRemoteConfigSchema,
  openCodeMcpRefConfigSchema,
]);

export const openCodeMcpServersSchema = z.record(
  z.string(),
  openCodeMcpServerConfigSchema,
);

const ENV_PLACEHOLDER_PATTERN = /\{env:[A-Za-z_][A-Za-z0-9_]*\}/gu;
const ENV_PLACEHOLDER_NAME_PATTERN = /\{env:([^}]+)\}/gu;
const AUTH_SCHEME_PATTERN = /^(?:bearer|basic|token)\s+/iu;

/**
 * Whether `value` carries nothing but `{env:VAR}` placeholders, optionally
 * behind an HTTP auth scheme (`Bearer {env:TOKEN}`). Anything else is a
 * literal that would be stored in plaintext, so a `local` server's
 * `environment` values and a `remote` server's `headers` values must pass it.
 */
export function isEnvPlaceholderValue(value: string): boolean {
  if (value.match(ENV_PLACEHOLDER_PATTERN) === null) return false;
  return (
    value
      .trim()
      .replace(AUTH_SCHEME_PATTERN, "")
      .replace(ENV_PLACEHOLDER_PATTERN, "")
      .trim() === ""
  );
}

/** A JSON-like value that may hold `{env:VAR}` placeholders in its strings. */
export type EnvPlaceholderSource =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly EnvPlaceholderSource[]
  | { readonly [key: string]: EnvPlaceholderSource };

/** Every variable name a value reads as `{env:VAR}`, at any depth, sorted. */
export function collectEnvPlaceholderNames(
  value: EnvPlaceholderSource,
): string[] {
  const names = new Set<string>();
  const visit = (item: EnvPlaceholderSource): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(ENV_PLACEHOLDER_NAME_PATTERN)) {
        if (match[1] !== undefined) names.add(match[1]);
      }
    } else if (typeof item === "object" && item !== null) {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return [...names].sort();
}

export type OpenCodeMcpRefConfig = z.infer<typeof openCodeMcpRefConfigSchema>;
export type OpenCodeMcpServerConfig = z.infer<
  typeof openCodeMcpServerConfigSchema
>;
export type OpenCodeMcpServers = z.infer<typeof openCodeMcpServersSchema>;
export type ResolvedOpenCodeMcpServerConfig = z.infer<
  typeof openCodeResolvedMcpServerConfigSchema
>;
export type ResolvedOpenCodeMcpServers = z.infer<
  typeof openCodeResolvedMcpServersSchema
>;
