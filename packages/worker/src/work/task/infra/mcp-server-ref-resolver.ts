import type {
  OpenCodeMcpRefConfig,
  OpenCodeMcpServers,
  ResolvedOpenCodeMcpServerConfig,
  ResolvedOpenCodeMcpServers,
} from "../../../common/contracts/opencode-mcp";
import type {
  DiscoveredAgentTools,
  InlineSecret,
} from "../../../project/agent-tools/domain/discovered-agent-tools";

/**
 * Builds the MCP servers a step's OpenCode config carries, from the step's
 * own entries and the repository's discovered servers
 * (`discoverRepoAgentTools`), which are the only source a ref resolves
 * against — the user's global OpenCode config is never consulted.
 *
 *   - A `{ type: "ref" }` entry is looked up by `name` (defaulting to its
 *     server key) among the discovered servers and replaced by the full
 *     v2 definition; the ref's shared fields (`disabled`, `codemode`,
 *     `timeout`, `protocol`) are laid on top. Its Boboddy-only `name` is
 *     dropped. A ref never reaches OpenCode. One that matches nothing throws
 *     {@link McpServerRefNotFoundError}.
 *   - Inline `local`/`remote` entries pass through unchanged.
 *   - Every discovered server whose name is not one of the step's keys is
 *     emitted with `disabled: true`, so a step only gets the servers it names
 *     — including servers OpenCode would otherwise load from the clone's own
 *     `.opencode/opencode.json[c]`. A ref aliased under another key
 *     (`db: { type: "ref", name: "postgres" }`) runs as `db` only; the
 *     original `postgres` is disabled.
 */

export class McpServerRefNotFoundError extends Error {
  readonly ref: string;
  readonly lookupName: string;
  readonly searched: readonly string[];

  constructor(input: {
    ref: string;
    lookupName: string;
    tools: DiscoveredAgentTools;
  }) {
    const searched = input.tools.searched.map((file) =>
      file.present
        ? `${file.file} (${file.path})`
        : `${file.file} (not present)`,
    );
    const skippedHere = input.tools.skipped.filter(
      (entry) => entry.kind === "server" && entry.name === input.lookupName,
    );
    const target =
      input.ref === input.lookupName
        ? `"${input.ref}"`
        : `"${input.ref}" (name "${input.lookupName}")`;
    const skippedNote = skippedHere
      .map(
        (entry) =>
          ` It is defined in ${entry.source} but could not be used: ${entry.reason}.`,
      )
      .join("");
    super(
      `MCP server ref ${target} was not found in the repository's MCP configs. Searched: ` +
        (searched.length > 0 ? searched.join(", ") : "no files") +
        "." +
        skippedNote +
        ' Define it in one of these files at the repository root, or declare it inline with defineMcp({ type: "local" | "remote" }).',
    );
    this.name = "McpServerRefNotFoundError";
    this.ref = input.ref;
    this.lookupName = input.lookupName;
    this.searched = searched;
  }
}

const SHARED_SERVER_FIELDS = [
  "disabled",
  "codemode",
  "timeout",
  "protocol",
] as const satisfies readonly (keyof OpenCodeMcpRefConfig &
  keyof ResolvedOpenCodeMcpServerConfig)[];

type SharedServerField = (typeof SHARED_SERVER_FIELDS)[number];

function applySharedFields(
  resolved: ResolvedOpenCodeMcpServerConfig,
  ref: OpenCodeMcpRefConfig,
): ResolvedOpenCodeMcpServerConfig {
  const overrides = Object.fromEntries(
    SHARED_SERVER_FIELDS.filter((field) => ref[field] !== undefined).map(
      (field) => [field, ref[field]],
    ),
  ) as Partial<Pick<OpenCodeMcpRefConfig, SharedServerField>>;
  return { ...resolved, ...overrides };
}

/** Where one ref was found. Carries no part of the definition, so it is safe to log. */
export type ResolvedMcpServerRef = {
  key: string;
  lookupName: string;
  /** Repo-relative file the definition came from. */
  source: string;
  type: ResolvedOpenCodeMcpServerConfig["type"];
  /** Credentials removed from the definition during discovery, by key. */
  inlineSecrets: InlineSecret[];
  /** Variables the definition reads as `{env:X}`, sorted. */
  requiredEnv: string[];
};

export type ResolveStepMcpServersResult = {
  /** `null` when the step declares nothing and the repository defines nothing. */
  servers: ResolvedOpenCodeMcpServers | null;
  resolvedRefs: ResolvedMcpServerRef[];
  /** Discovered servers emitted as `disabled: true`, by name. */
  disabledServers: string[];
};

export function resolveStepMcpServers(input: {
  servers: OpenCodeMcpServers | null | undefined;
  tools: DiscoveredAgentTools;
}): ResolveStepMcpServersResult {
  const discovered = new Map(
    input.tools.servers.map((server) => [server.name, server]),
  );
  const servers: ResolvedOpenCodeMcpServers = {};
  const resolvedRefs: ResolvedMcpServerRef[] = [];
  const used = new Set<string>();

  for (const [key, entry] of Object.entries(input.servers ?? {})) {
    if (entry.type !== "ref") {
      servers[key] = entry;
      used.add(key);
      continue;
    }

    const lookupName = entry.name ?? key;
    const match = discovered.get(lookupName);
    if (match === undefined) {
      throw new McpServerRefNotFoundError({
        ref: key,
        lookupName,
        tools: input.tools,
      });
    }
    servers[key] = applySharedFields(match.config, entry);
    used.add(key);
    resolvedRefs.push({
      key,
      lookupName,
      source: match.source,
      type: match.config.type,
      inlineSecrets: match.inlineSecrets,
      requiredEnv: match.requiredEnv,
    });
  }

  const disabledServers: string[] = [];
  for (const server of input.tools.servers) {
    if (used.has(server.name)) continue;
    servers[server.name] = { ...server.config, disabled: true };
    disabledServers.push(server.name);
  }

  return {
    servers: Object.keys(servers).length > 0 ? servers : null,
    resolvedRefs,
    disabledServers,
  };
}
