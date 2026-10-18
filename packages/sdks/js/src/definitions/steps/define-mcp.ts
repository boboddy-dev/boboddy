import { z } from "zod";
import { ENV_VAR_NAME_PATTERN, isReservedEnvVarName } from "../../env-vars";
import { toolHealthCheckSchema } from "../../health-checks";
import {
  parseMcpServer,
  type McpServerConfig,
  type McpServerDefinition,
} from "./mcp-server-config";

export type {
  McpLocalServerFields,
  McpRefServerFields,
  McpRemoteServerFields,
  McpServerDefinition,
  McpServerType,
} from "./mcp-server-config";

/**
 * `defineMcp`: a reusable definition of an MCP server together with the env
 * vars it needs and its health checks. The server is a `ref` to one in the
 * repo's MCP config, or written inline as `local` or `remote` (see
 * `mcp-server-config.ts`). A step
 * mounts it under `defineStep({ mcps: { key: handle } })`, and
 * `compile-mcps.ts` turns it into the existing wire fields (`opencodeMcpJson`,
 * `healthChecksJson`, `envJson`).
 *
 * Severity belongs to each health check (default `required`); a step changes
 * it with `overrideCheck(name, { severity })`. The server itself has none.
 *
 * A handle is immutable. Every builder method returns a new frozen handle with
 * one more entry in its op log (`overrides`); the log is resolved once, at
 * compile time, by `resolveMcpChecks`. Precedence:
 *
 * - `overrideCheck` patches fields; later patches of the same field win and
 *   `args` is replaced whole. It never changes whether a check is enabled, so a
 *   `disableCheck` wins over it regardless of order.
 * - Between `enableCheck`, `disableCheck` and `disableAllChecks`, the last op
 *   touching a check wins. `disableAllChecks` disables every check known at
 *   that point; a later `enableCheck` or `addCheck` turns checks back on.
 */

const mcpCheckInputSchema = toolHealthCheckSchema
  .omit({ kind: true, mcp: true, name: true })
  .extend({ enabled: z.boolean().optional() })
  .strict();

const mcpCheckPatchSchema = toolHealthCheckSchema
  .pick({
    tool: true,
    args: true,
    timeoutSeconds: true,
    severity: true,
    serialGroup: true,
  })
  .partial()
  .strict();

type ToolCheckAuthoring = Omit<
  z.input<typeof toolHealthCheckSchema>,
  "kind" | "mcp" | "name"
>;

/** A health check on a `defineMcp` server: a tool check without `mcp`/`name`. */
export type McpCheckInput = ToolCheckAuthoring & { enabled?: boolean };

/** The fields `overrideCheck` may change. */
export type McpCheckPatch = Partial<
  Pick<
    McpCheckInput,
    "tool" | "args" | "timeoutSeconds" | "severity" | "serialGroup"
  >
>;

export type McpOp =
  | {
      readonly op: "override";
      readonly name: string;
      readonly patch: McpCheckPatch;
    }
  | { readonly op: "enable"; readonly name: string }
  | { readonly op: "disable"; readonly name: string }
  | { readonly op: "add"; readonly name: string; readonly check: McpCheckInput }
  | { readonly op: "disableAll" };

/**
 * `{ type: "ref", name }`, `{ type: "local", name, command, cwd?,
 * environment? }` or `{ type: "remote", name, url, headers?, oauth? }`, each
 * with the shared OpenCode fields (`timeout`, `protocol`, `codemode`). Inline
 * `environment` and `headers` values must be written as `{env:VAR}`.
 */
export type DefineMcpConfig<TChecks extends Record<string, McpCheckInput>> =
  McpServerConfig & {
    /** Worker env vars the server needs; a missing one fails the step. */
    env?: readonly string[];
    /** Worker env vars passed through when set. */
    optionalEnv?: readonly string[];
    healthChecks?: TChecks;
  };

type McpHandleData = {
  readonly env: readonly string[];
  readonly optionalEnv: readonly string[];
  /** The checks from `defineMcp`; `addCheck`ed checks live in `overrides`. */
  readonly checks: Readonly<Record<string, Readonly<McpCheckInput>>>;
  readonly overrides: readonly McpOp[];
};

interface McpHandleMethods<TNames extends string> {
  overrideCheck(name: TNames, patch: McpCheckPatch): McpHandle<TNames>;
  disableCheck(name: TNames): McpHandle<TNames>;
  enableCheck(name: TNames): McpHandle<TNames>;
  addCheck<N extends string>(
    name: N & Exclude<N, TNames>,
    check: McpCheckInput,
  ): McpHandle<TNames | N>;
  disableAllChecks(): McpHandle<TNames>;
}

/**
 * An immutable `defineMcp` server: `type`, `name` and `server` (its OpenCode
 * fields; for a `ref`, only the shared ones), its env vars, checks and op log.
 */
export type McpHandle<TNames extends string = string> = McpServerDefinition &
  McpHandleData &
  McpHandleMethods<TNames>;

export type ResolvedMcpCheck = {
  readonly name: string;
  readonly check: McpCheckInput;
  readonly enabled: boolean;
};

type McpState = McpServerDefinition & McpHandleData;

const handles = new WeakSet();

/** True for a handle built by `defineMcp` or one of its builder methods. */
// eslint-disable-next-line local/no-unknown-parameter-type -- runtime guard over author-supplied `mcps` values
export function isMcpHandle(value: unknown): value is McpHandle {
  return typeof value === "object" && value !== null && handles.has(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

function assertCheckName(label: string, name: string): void {
  if (name.trim().length === 0 || name.includes(".")) {
    throw new Error(
      `defineMcp "${label}": health check name "${name}" must be non-empty and contain no ".".`,
    );
  }
}

function assertCheckInput(
  label: string,
  name: string,
  check: McpCheckInput,
): void {
  assertCheckName(label, name);
  const parsed = mcpCheckInputSchema.safeParse(check);
  if (!parsed.success) {
    throw new Error(
      `defineMcp "${label}" health check "${name}": ${formatIssues(parsed.error)}`,
    );
  }
}

function assertEnvNames(
  label: string,
  env: readonly string[],
  optionalEnv: readonly string[],
): void {
  const seen = new Set<string>();
  for (const name of [...env, ...optionalEnv]) {
    if (!ENV_VAR_NAME_PATTERN.test(name)) {
      throw new Error(
        `defineMcp "${label}": env var "${name}" must match ${String(ENV_VAR_NAME_PATTERN)}.`,
      );
    }
    if (isReservedEnvVarName(name)) {
      throw new Error(
        `defineMcp "${label}": env var "${name}" is reserved for Boboddy.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `defineMcp "${label}": env var "${name}" is declared more than once.`,
      );
    }
    seen.add(name);
  }
}

function knownCheckNames(state: McpState): Set<string> {
  const names = new Set(Object.keys(state.checks));
  for (const op of state.overrides) {
    if (op.op === "add") names.add(op.name);
  }
  return names;
}

function assertKnownCheck(state: McpState, method: string, name: string): void {
  const known = knownCheckNames(state);
  if (known.has(name)) return;
  throw new Error(
    `defineMcp "${state.name}".${method}: unknown health check "${name}". Known checks: ${known.size > 0 ? [...known].join(", ") : "(none)"}.`,
  );
}

function withOp(state: McpState, op: McpOp): McpHandle {
  return createHandle({
    ...state,
    overrides: Object.freeze([...state.overrides, deepFreeze(op)]),
  });
}

function createHandle(state: McpState): McpHandle {
  const handle: McpHandle = {
    ...state,
    overrideCheck: (name, patch) => {
      assertKnownCheck(state, "overrideCheck", name);
      const parsed = mcpCheckPatchSchema.safeParse(patch);
      if (!parsed.success) {
        throw new Error(
          `defineMcp "${state.name}".overrideCheck("${name}"): ${formatIssues(parsed.error)}`,
        );
      }
      return withOp(state, {
        op: "override",
        name,
        patch: structuredClone(patch),
      });
    },
    disableCheck: (name) => {
      assertKnownCheck(state, "disableCheck", name);
      return withOp(state, { op: "disable", name });
    },
    enableCheck: (name) => {
      assertKnownCheck(state, "enableCheck", name);
      return withOp(state, { op: "enable", name });
    },
    addCheck: (name: string, check: McpCheckInput) => {
      assertCheckInput(state.name, name, check);
      if (knownCheckNames(state).has(name)) {
        throw new Error(
          `defineMcp "${state.name}".addCheck: health check "${name}" already exists; use overrideCheck to change it.`,
        );
      }
      return withOp(state, { op: "add", name, check: structuredClone(check) });
    },
    disableAllChecks: () => withOp(state, { op: "disableAll" }),
  };
  handles.add(handle);
  return Object.freeze(handle);
}

/**
 * Defines an MCP server once, with its env vars and health checks. Throws on
 * an invalid server field, a literal `environment`/`headers` value, or an
 * invalid check or env var name.
 */
export function defineMcp<
  TChecks extends Record<string, McpCheckInput> = Record<never, never>,
>(config: DefineMcpConfig<TChecks>): McpHandle<keyof TChecks & string> {
  const definition = parseMcpServer(config);
  const env = config.env ?? [];
  const optionalEnv = config.optionalEnv ?? [];
  assertEnvNames(definition.name, env, optionalEnv);
  const checks: Record<string, McpCheckInput> = config.healthChecks ?? {};
  for (const [name, check] of Object.entries(checks)) {
    assertCheckInput(definition.name, name, check);
  }
  return createHandle({
    ...frozenCopy(definition),
    env: frozenCopy([...env]),
    optionalEnv: frozenCopy([...optionalEnv]),
    checks: frozenCopy({ ...checks }),
    overrides: Object.freeze([]),
  });
}

/**
 * Replays a handle's op log over its checks and returns every check, in
 * definition then `addCheck` order, with its patched fields and whether it is
 * enabled. See the module comment for the precedence rules.
 */
export function resolveMcpChecks(handle: McpHandle): ResolvedMcpCheck[] {
  const resolved = new Map<
    string,
    { check: McpCheckInput; enabled: boolean }
  >();
  for (const [name, check] of Object.entries(handle.checks)) {
    resolved.set(name, { check: { ...check }, enabled: check.enabled ?? true });
  }
  for (const op of handle.overrides) {
    if (op.op === "add") {
      resolved.set(op.name, {
        check: { ...op.check },
        enabled: op.check.enabled ?? true,
      });
    } else if (op.op === "disableAll") {
      for (const entry of resolved.values()) entry.enabled = false;
    } else {
      const entry = resolved.get(op.name);
      if (!entry) continue;
      if (op.op === "override") entry.check = { ...entry.check, ...op.patch };
      else entry.enabled = op.op === "enable";
    }
  }
  return [...resolved].map(([name, { check, enabled }]) => ({
    name,
    check,
    enabled,
  }));
}
