import {
  appliesToAgent,
  appliesToSetup,
  isUninheritableWorkerEnvVarName,
  type EnvVarSpec,
} from "@boboddy/sdk/env-vars";
import { renderPromptTemplate } from "@boboddy/sdk/definitions/steps";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";

/**
 * Resolves a step's declared `envJson` against a run's input and the worker's
 * environment. Pure: the worker host's env (`.boboddy/.env` over `process.env`)
 * is passed in as `workerEnv`, never read here.
 *
 * - `value`: the template rendered against `{ input }`.
 * - `inherit`: `workerEnv[from]`, else `default`, else omitted when
 *   `optional`, else reported as missing.
 *
 * `applies` routes each resolved variable: `agent` into `stepEnv` (the agent
 * or code step), `setup` into `setupEnv` (the `devcontainer up` process),
 * `both` into both.
 *
 * Every missing required name, tagged with an `mcp` key or not, is collected
 * into a single {@link MissingStepEnvError}; its message names variables (and
 * their MCP), never values.
 */

/** One planned MCP server ref: the variables its repo definition reads (`{env:X}`). */
export type McpEnvRef = {
  key: string;
  requiredEnv: readonly string[];
};

export type ResolvedStepEnv = {
  /** Every variable that applies to the agent, secret or not: what is injected into the run. */
  stepEnv: Record<string, string>;
  /** Every variable that applies to setup: the host env of `devcontainer up`. */
  setupEnv: Record<string, string>;
  /** The non-secret subset of `stepEnv`, safe to render into the agent prompt. */
  promptEnv: Record<string, string>;
  /** Resolved values of secret entries, agent or setup, to register with the log masker. */
  secretValues: string[];
};

export class MissingStepEnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Step declares required environment variables that are not set on the worker: ${missing.join(", ")}. ` +
        "Set them in .boboddy/.env or the worker's environment, or mark them optional.",
    );
    this.name = "MissingStepEnvError";
    this.missing = missing;
  }
}

function describeMissing(
  entry: Extract<EnvVarSpec, { source: "inherit" }>,
): string {
  const owners = [
    ...(entry.from === entry.name ? [] : [entry.name]),
    ...(entry.mcp === undefined ? [] : [`MCP "${entry.mcp}"`]),
  ];
  return owners.length > 0
    ? `${entry.from} (for ${owners.join(", ")})`
    : entry.from;
}

export function resolveStepEnv(input: {
  envJson: readonly EnvVarSpec[] | null | undefined;
  inputJson: unknown;
  workerEnv: Readonly<Record<string, string | undefined>>;
}): ResolvedStepEnv {
  const stepEnv: Record<string, string> = {};
  const setupEnv: Record<string, string> = {};
  const promptEnv: Record<string, string> = {};
  const secretValues: string[] = [];
  const missing: string[] = [];

  for (const entry of input.envJson ?? []) {
    let resolved: string | undefined;

    if (entry.source === "value") {
      resolved = renderPromptTemplate(entry.value, { input: input.inputJson });
    } else {
      if (isUninheritableWorkerEnvVarName(entry.from)) {
        throw new Error(
          `Step env "${entry.name}" cannot inherit worker variable "${entry.from}": BOBODDY_* variables are reserved for the worker.`,
        );
      }
      resolved = input.workerEnv[entry.from] ?? entry.default;
      if (resolved === undefined) {
        if (!entry.optional) missing.push(describeMissing(entry));
        continue;
      }
    }

    const toAgent = appliesToAgent(entry.applies);
    if (toAgent) stepEnv[entry.name] = resolved;
    if (appliesToSetup(entry.applies)) setupEnv[entry.name] = resolved;
    if (entry.secret) {
      if (resolved.length > 0) secretValues.push(resolved);
    } else if (toAgent) {
      promptEnv[entry.name] = resolved;
    }
  }

  if (missing.length > 0) throw new MissingStepEnvError(missing);

  return { stepEnv, setupEnv, promptEnv, secretValues };
}

/**
 * D3: every `{env:X}` a ref'd server's repo definition reads is a required,
 * secret, inherited variable of that MCP, unless the step already declares
 * `X` itself for the agent (D4: the step's own entry wins; a setup-only entry
 * does not reach the agent, so the MCP still gets its own). A name read by
 * several refs is tagged with the first of them.
 */
export function withInferredMcpEnv(
  envJson: readonly EnvVarSpec[] | null | undefined,
  refs: readonly McpEnvRef[],
): EnvVarSpec[] {
  const declared = new Set(
    (envJson ?? [])
      .filter((entry) => appliesToAgent(entry.applies))
      .map((entry) => entry.name),
  );
  const owner = new Map<string, McpEnvRef>();
  for (const ref of refs) {
    for (const name of ref.requiredEnv) {
      if (declared.has(name) || owner.has(name)) continue;
      owner.set(name, ref);
    }
  }
  return [
    ...(envJson ?? []),
    ...[...owner].map(([name, ref]): EnvVarSpec => ({
      source: "inherit",
      name,
      from: name,
      secret: true,
      optional: false,
      mcp: ref.key,
      applies: "agent",
    })),
  ];
}

function hasMcpRefs(servers: OpenCodeMcpServers | null | undefined): boolean {
  return Object.values(servers ?? {}).some((entry) => entry.type === "ref");
}

/**
 * Resolves a step's env before launch, and — when the step names MCP server
 * refs — a resolver the launch calls once it has discovered the refs, adding
 * each ref's inferred variables (D3). A step without refs gets no resolver,
 * so its launch is unchanged.
 */
export function planStepEnv(input: {
  envJson: readonly EnvVarSpec[] | null | undefined;
  inputJson: unknown;
  workerEnv: Readonly<Record<string, string | undefined>>;
  opencodeMcpJson: OpenCodeMcpServers | null | undefined;
}): {
  resolved: ResolvedStepEnv;
  resolveMcpEnv: ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
} {
  const resolve = (envJson: readonly EnvVarSpec[] | null | undefined) =>
    resolveStepEnv({
      envJson,
      inputJson: input.inputJson,
      workerEnv: input.workerEnv,
    });
  return {
    resolved: resolve(input.envJson),
    resolveMcpEnv: hasMcpRefs(input.opencodeMcpJson)
      ? (refs) => resolve(withInferredMcpEnv(input.envJson, refs))
      : undefined,
  };
}
