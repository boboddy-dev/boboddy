import type { z } from "zod";
import { ENV_VAR_NAME_PATTERN, isReservedEnvVarName } from "../../env-vars";
import {
  collectEnvPlaceholderNames,
  isEnvPlaceholderValue,
  openCodeMcpLocalConfigSchema,
  openCodeMcpRefConfigSchema,
  openCodeMcpRemoteConfigSchema,
} from "../../opencode-mcp";

/**
 * The server half of a `defineMcp` config: which server it is (`type` +
 * `name`) and, for `local`/`remote`, how OpenCode launches it. `type` and
 * `disabled` belong to `defineMcp`, so they are not authored here.
 */

const ownedFields = { type: true, disabled: true } as const;

const refFieldsSchema = openCodeMcpRefConfigSchema.omit({
  ...ownedFields,
  name: true,
});
const localFieldsSchema = openCodeMcpLocalConfigSchema.omit(ownedFields);
const remoteFieldsSchema = openCodeMcpRemoteConfigSchema.omit(ownedFields);

/** The shared OpenCode fields a `ref` applies on top of the repo's definition. */
export type McpRefServerFields = z.output<typeof refFieldsSchema>;
/** A `local` server: `command`, `cwd?`, `environment?` and the shared fields. */
export type McpLocalServerFields = z.output<typeof localFieldsSchema>;
/** A `remote` server: `url`, `headers?`, `oauth?` and the shared fields. */
export type McpRemoteServerFields = z.output<typeof remoteFieldsSchema>;

export type McpServerType = "ref" | "local" | "remote";

/**
 * A `defineMcp` server. For `ref`, `name` is the server's name in the repo's
 * MCP config. For `local`/`remote`, `name` only labels the server in errors;
 * the step's `mcps` key names it at runtime.
 */
export type McpServerDefinition =
  | {
      readonly type: "ref";
      readonly name: string;
      readonly server: Readonly<McpRefServerFields>;
    }
  | {
      readonly type: "local";
      readonly name: string;
      readonly server: Readonly<McpLocalServerFields>;
    }
  | {
      readonly type: "remote";
      readonly name: string;
      readonly server: Readonly<McpRemoteServerFields>;
    };

export type McpServerConfig =
  | ({ type: "ref"; name: string } & z.input<typeof refFieldsSchema>)
  | ({ type: "local"; name: string } & z.input<typeof localFieldsSchema>)
  | ({ type: "remote"; name: string } & z.input<typeof remoteFieldsSchema>);

const commonConfigKeys = new Set([
  "type",
  "name",
  "env",
  "optionalEnv",
  "healthChecks",
]);

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

function parseFields<T>(
  name: string,
  schema: z.ZodType<T>,
  config: McpServerConfig,
): T {
  const fields = Object.fromEntries(
    Object.entries(config).filter(([key]) => !commonConfigKeys.has(key)),
  );
  const parsed = schema.safeParse(fields);
  if (!parsed.success) {
    throw new Error(`defineMcp "${name}": ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

function assertPlaceholders(
  name: string,
  field: "environment" | "headers",
  values: Readonly<Record<string, string>> | undefined,
): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (isEnvPlaceholderValue(value)) continue;
    throw new Error(
      `defineMcp "${name}": ${field}.${key} must be written as {env:VAR}; a literal ${field} value would be stored in plaintext.`,
    );
  }
}

/**
 * The `{env:VAR}` names an inline server reads, which compile into required
 * env entries tagged with the server's key. Empty for a `ref`: the worker
 * infers those from the repo's definition.
 */
export function inferredMcpEnv(definition: McpServerDefinition): string[] {
  return definition.type === "ref"
    ? []
    : collectEnvPlaceholderNames(definition.server);
}

function assertInferredEnv(definition: McpServerDefinition): void {
  for (const variable of inferredMcpEnv(definition)) {
    if (!ENV_VAR_NAME_PATTERN.test(variable)) {
      throw new Error(
        `defineMcp "${definition.name}": {env:${variable}} must name a variable matching ${String(ENV_VAR_NAME_PATTERN)}.`,
      );
    }
    if (isReservedEnvVarName(variable)) {
      throw new Error(
        `defineMcp "${definition.name}": {env:${variable}} reads a variable reserved for Boboddy.`,
      );
    }
  }
}

/**
 * Validates a `defineMcp` config's server half and returns it with its
 * OpenCode fields parsed. Throws on an unknown `type`, an invalid field, a
 * literal (non-`{env:VAR}`) `environment` or `headers` value, or a
 * placeholder naming an invalid or reserved variable.
 */
export function parseMcpServer(config: McpServerConfig): McpServerDefinition {
  if (typeof config.name !== "string" || config.name.trim().length === 0) {
    throw new Error("defineMcp: name must be a non-empty string.");
  }
  const { name } = config;
  let definition: McpServerDefinition;
  switch (config.type) {
    case "ref":
      definition = {
        type: "ref",
        name,
        server: parseFields(name, refFieldsSchema, config),
      };
      break;
    case "local": {
      const server = parseFields(name, localFieldsSchema, config);
      assertPlaceholders(name, "environment", server.environment);
      definition = { type: "local", name, server };
      break;
    }
    case "remote": {
      const server = parseFields(name, remoteFieldsSchema, config);
      assertPlaceholders(name, "headers", server.headers);
      definition = { type: "remote", name, server };
      break;
    }
    default:
      throw new Error(
        `defineMcp "${name}": type must be "ref", "local" or "remote".`,
      );
  }
  assertInferredEnv(definition);
  return definition;
}
