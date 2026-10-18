import type { EnvVarSpec, EnvVarsInput } from "../../env-vars";
import type { HealthChecksInput } from "../../health-checks";
import type {
  OpenCodeMcpServerConfig,
  OpenCodeMcpServers,
} from "../../opencode-mcp";
import { isMcpHandle, resolveMcpChecks, type McpHandle } from "./define-mcp";
import { inferredMcpEnv } from "./mcp-server-config";

/**
 * Compiles a step's `mcps` (`defineMcp` handles keyed by the step's server
 * key) into the wire fields, and merges them with the step's own
 * `healthChecks` and `environment.vars`.
 */

type InheritEnvVarSpec = Extract<EnvVarSpec, { source: "inherit" }>;

export type CompiledMcps = {
  opencodeMcpJson: OpenCodeMcpServers;
  healthChecks: HealthChecksInput;
  envEntries: InheritEnvVarSpec[];
};

export type StepMcpFields = {
  opencodeMcpJson: OpenCodeMcpServers | null;
  healthChecksJson: HealthChecksInput | null;
  envJson: EnvVarsInput | null;
};

function compileServer(
  key: string,
  handle: McpHandle,
): OpenCodeMcpServerConfig {
  switch (handle.type) {
    case "ref":
      return {
        type: "ref",
        ...(handle.name !== key ? { name: handle.name } : {}),
        ...structuredClone(handle.server),
      };
    case "local":
      return { type: "local", ...structuredClone(handle.server) };
    case "remote":
      return { type: "remote", ...structuredClone(handle.server) };
  }
}

function compileChecks(key: string, handle: McpHandle): HealthChecksInput {
  return resolveMcpChecks(handle)
    .filter((resolved) => resolved.enabled)
    .map(({ name, check }) => ({
      kind: "tool" as const,
      mcp: key,
      name: `${key}.${name}`,
      tool: check.tool,
      ...(check.args !== undefined ? { args: check.args } : {}),
      ...(check.timeoutSeconds !== undefined
        ? { timeoutSeconds: check.timeoutSeconds }
        : {}),
      serialGroup: check.serialGroup ?? key,
      severity: check.severity ?? "required",
    }));
}

/**
 * MCP variables always apply to the agent: MCP servers run inside it. An
 * inline server's `{env:VAR}` names are required unless listed in
 * `optionalEnv`, the same as the worker infers them for a `ref`.
 */
function compileEnv(key: string, handle: McpHandle): InheritEnvVarSpec[] {
  const entry = (name: string, optional: boolean): InheritEnvVarSpec => ({
    source: "inherit",
    name,
    from: name,
    secret: true,
    optional,
    mcp: key,
    applies: "agent",
  });
  const listed = new Set([...handle.env, ...handle.optionalEnv]);
  const inferred = inferredMcpEnv(handle).filter((name) => !listed.has(name));
  return [
    ...handle.env.map((name) => entry(name, false)),
    ...inferred.map((name) => entry(name, false)),
    ...handle.optionalEnv.map((name) => entry(name, true)),
  ];
}

/**
 * Two servers declaring the same var collapse into one entry: required if
 * either requires it, and untagged, since no single server owns it.
 */
function dedupeEnv(entries: InheritEnvVarSpec[]): InheritEnvVarSpec[] {
  const byName = new Map<string, InheritEnvVarSpec>();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (!existing) {
      byName.set(entry.name, entry);
      continue;
    }
    byName.set(entry.name, {
      source: "inherit",
      name: entry.name,
      from: entry.from,
      secret: true,
      optional: existing.optional && entry.optional,
      applies: "agent",
    });
  }
  return [...byName.values()];
}

/** Throws when a value under `mcps` is not a `defineMcp` handle. */
export function compileMcps(
  mcps: Readonly<Record<string, McpHandle>>,
  stepKey: string,
): CompiledMcps {
  const compiled: CompiledMcps = {
    opencodeMcpJson: {},
    healthChecks: [],
    envEntries: [],
  };
  for (const [key, handle] of Object.entries(mcps)) {
    if (!isMcpHandle(handle)) {
      throw new Error(
        `Step "${stepKey}" mcps.${key}: expected a handle from defineMcp().`,
      );
    }
    compiled.opencodeMcpJson[key] = compileServer(key, handle);
    compiled.healthChecks.push(...compileChecks(key, handle));
    compiled.envEntries.push(...compileEnv(key, handle));
  }
  compiled.envEntries = dedupeEnv(compiled.envEntries);
  return compiled;
}

function nonEmpty<T>(items: T[]): T[] | null {
  return items.length > 0 ? items : null;
}

/**
 * Merges compiled `mcps` into the step's own fields: MCP checks run before the
 * step's own, and a step var replaces an MCP var of the same name.
 */
export function mergeStepMcps(
  stepKey: string,
  input: {
    mcps: Readonly<Record<string, McpHandle>> | undefined;
    healthChecks: HealthChecksInput | null | undefined;
    envJson: EnvVarsInput | null;
  },
): StepMcpFields {
  if (!input.mcps || Object.keys(input.mcps).length === 0) {
    return {
      opencodeMcpJson: null,
      healthChecksJson: input.healthChecks ?? null,
      envJson: input.envJson,
    };
  }
  const compiled = compileMcps(input.mcps, stepKey);
  const stepVars = input.envJson ?? [];
  const stepVarNames = new Set(stepVars.map((entry) => entry.name));
  return {
    opencodeMcpJson: compiled.opencodeMcpJson,
    healthChecksJson: nonEmpty([
      ...compiled.healthChecks,
      ...(input.healthChecks ?? []),
    ]),
    envJson: nonEmpty([
      ...compiled.envEntries.filter((entry) => !stepVarNames.has(entry.name)),
      ...stepVars,
    ]),
  };
}
