import { z } from "zod";

/**
 * Wire schema for a step's declared environment variables (`envJson`).
 *
 * A step declares each variable one of two ways, discriminated on `source`:
 *
 * - `value`: a literal or `{{input.…}}` template, stored in the definition
 *   and rendered per run. `secret` only controls log masking.
 * - `inherit`: read from the **worker** host at run time (`.boboddy/.env`,
 *   then `process.env`). Only the variable *name* is stored.
 *
 * Values travel to the container as `docker exec -e` argv, hence the entry
 * count and value length caps.
 */

export const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Names Boboddy manages itself; a step may not declare them. */
export const RESERVED_ENV_VAR_NAMES: readonly string[] = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "OPENCODE_CONFIG_CONTENT",
  "npm_config_cache",
];

export const RESERVED_ENV_VAR_PREFIX = "BOBODDY_";

export const MAX_ENV_VARS = 64;
export const MAX_ENV_VAR_NAME_LENGTH = 128;
export const MAX_ENV_VAR_VALUE_LENGTH = 4096;

const INPUT_TOKEN_PATTERN = /\{\{input\.[^}]+\}\}/;

/** True when `value` interpolates at least one `{{input.…}}` token. */
export function containsInputToken(value: string): boolean {
  return INPUT_TOKEN_PATTERN.test(value);
}

export function isReservedEnvVarName(name: string): boolean {
  return (
    name.startsWith(RESERVED_ENV_VAR_PREFIX) ||
    RESERVED_ENV_VAR_NAMES.includes(name)
  );
}

const envVarNameSchema = z
  .string()
  .max(MAX_ENV_VAR_NAME_LENGTH)
  .regex(ENV_VAR_NAME_PATTERN, "must match /^[A-Z_][A-Z0-9_]*$/")
  .refine((name) => !isReservedEnvVarName(name), {
    message: `is reserved (BOBODDY_*, ${RESERVED_ENV_VAR_NAMES.join(", ")})`,
  });

const envVarValueSchema = z.string().max(MAX_ENV_VAR_VALUE_LENGTH);

/**
 * True when `name` is a worker-side variable an `inherit` entry may not read:
 * `BOBODDY_*` carries the worker's own credentials and configuration, which
 * must never be copied into a step's agent container.
 */
export function isUninheritableWorkerEnvVarName(name: string): boolean {
  return name.toUpperCase().startsWith(RESERVED_ENV_VAR_PREFIX);
}

const valueEnvVarSchema = z
  .object({
    name: envVarNameSchema,
    source: z.literal("value"),
    value: envVarValueSchema,
    secret: z.boolean(),
  })
  .strict()
  .refine((entry) => !entry.secret || containsInputToken(entry.value), {
    path: ["value"],
    message:
      "a secret value must contain an {{input.…}} token; a static secret would be stored in plaintext. Use Env.inherit({ secret: true }) instead",
  });

const inheritEnvVarSchema = z
  .object({
    name: envVarNameSchema,
    source: z.literal("inherit"),
    from: z
      .string()
      .max(MAX_ENV_VAR_NAME_LENGTH)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        "must be a valid environment variable name",
      )
      .refine((from) => !isUninheritableWorkerEnvVarName(from), {
        message: `cannot read worker variables starting with ${RESERVED_ENV_VAR_PREFIX}`,
      }),
    secret: z.boolean(),
    optional: z.boolean(),
    default: envVarValueSchema.optional(),
  })
  .strict()
  .refine((entry) => !(entry.secret && entry.default !== undefined), {
    path: ["default"],
    message: "a secret cannot carry a default; it would be stored in plaintext",
  });

export const envVarSpecSchema = z.discriminatedUnion("source", [
  valueEnvVarSchema,
  inheritEnvVarSchema,
]);

/**
 * The full value of a step's `envJson`: a bounded list of uniquely named
 * entries.
 */
export const envVarsSchema = z
  .array(envVarSpecSchema)
  .max(MAX_ENV_VARS)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.name)).size === entries.length,
    { message: "environment variable names must be unique" },
  );

/**
 * Read-side schema for `envJson` as persisted and served. Structural only:
 * unknown keys are stripped and the write-time refinements (reserved names,
 * caps, secret rules) are not re-applied, so tightening those rules can never
 * make an already-stored row unreadable. Only a change to the stored shape
 * itself can break it, and `test/env-vars-stored-compat.test.ts` pins that.
 */
export const storedEnvVarsSchema = z.array(
  z.discriminatedUnion("source", [
    z.object({
      name: z.string(),
      source: z.literal("value"),
      value: z.string(),
      secret: z.boolean(),
    }),
    z.object({
      name: z.string(),
      source: z.literal("inherit"),
      from: z.string(),
      secret: z.boolean(),
      optional: z.boolean(),
      default: z.string().optional(),
    }),
  ]),
);

export type EnvVarSpec = z.infer<typeof envVarSpecSchema>;
export type EnvVarsInput = z.input<typeof envVarsSchema>;
