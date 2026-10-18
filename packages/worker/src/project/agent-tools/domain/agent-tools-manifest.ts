import path from "node:path";
import type { AnyJsonObject } from "../../../common/contracts/json";
import type {
  DiscoveredAgentTools,
  DiscoveredMcpServer,
  InlineSecret,
  SkippedAgentTool,
} from "./discovered-agent-tools";

/**
 * `discovered-tools.json`: everything the pipeline designer needs to know
 * about the MCP servers and skills a repository defines, written by the
 * `pipelines design` preflight outside the repository at
 * `~/.boboddy/projects/<owner>/<slug>/discovered-tools.json`.
 *
 * It carries names only. No env, header or argument value is ever written:
 * a server lists the variable names it reads, and its tools as the server
 * itself reported them.
 */

export const AGENT_TOOLS_MANIFEST_FILENAME = "discovered-tools.json";

/** Recorded in every manifest, so the designer never over-reads a listing. */
export const AGENT_TOOLS_MANIFEST_CAVEATS: readonly string[] = [
  "Tools were listed by starting each server on the user's machine. For a local server that proves the definition works, not that its command exists inside the devcontainer a workspace step runs in.",
];

/** One tool as its server listed it. */
export type ListedMcpTool = {
  name: string;
  description?: string;
  inputSchema: AnyJsonObject;
  /** The `readOnlyHint` annotation, when the server sets one. */
  readOnlyHint?: boolean;
};

/** Whether the preflight could list a server's tools, and if not, why. */
export type McpServerAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

export type ManifestMcpServer = {
  name: string;
  /** Repo-relative file the definition came from. */
  source: string;
  transport: DiscoveredMcpServer["transport"];
  requiredEnv: string[];
  /** Literal credentials discovery dropped from the definition, by key. */
  inlineSecrets: Omit<InlineSecret, "inlineSecret">[];
  /** Lower-precedence files that also define this name. */
  shadowed: string[];
  /** `true` when the source file turns the server off. */
  disabledInSource?: true;
  availability: McpServerAvailability;
  tools: ListedMcpTool[];
};

export type AgentToolsManifest = {
  version: 1;
  generatedAt: string;
  /** The `owner/slug` project this repository is linked to. */
  project: string;
  caveats: readonly string[];
  servers: ManifestMcpServer[];
  skills: { name: string; description: string; path: string }[];
  /** Entries discovery found but could not use, with the reason. */
  skipped: SkippedAgentTool[];
  /** Repo-relative MCP config files looked at, and whether each exists. */
  searched: { file: string; present: boolean }[];
};

/** Where the manifest for `owner/slug` lives under `homeDir`. */
export function agentToolsManifestPath(input: {
  homeDir: string;
  owner: string;
  slug: string;
}): string {
  return path.join(
    input.homeDir,
    ".boboddy",
    "projects",
    input.owner,
    input.slug,
    AGENT_TOOLS_MANIFEST_FILENAME,
  );
}

/** The `requiredEnv` names that are unset or empty in `env`. */
export function missingRequiredEnv(
  server: Pick<DiscoveredMcpServer, "requiredEnv">,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return server.requiredEnv.filter((name) => {
    const value = env[name];
    return value === undefined || value === "";
  });
}

export function buildAgentToolsManifest(input: {
  project: string;
  generatedAt: Date;
  discovered: DiscoveredAgentTools;
  /** Per server name; a server with no entry is recorded as not listed. */
  listings: ReadonlyMap<
    string,
    { availability: McpServerAvailability; tools: ListedMcpTool[] }
  >;
}): AgentToolsManifest {
  const { discovered } = input;
  return {
    version: 1,
    generatedAt: input.generatedAt.toISOString(),
    project: input.project,
    caveats: AGENT_TOOLS_MANIFEST_CAVEATS,
    servers: discovered.servers.map((server) => {
      const listing = input.listings.get(server.name) ?? {
        availability: { status: "failed", reason: "not listed" },
        tools: [],
      };
      return {
        name: server.name,
        source: server.source,
        transport: server.transport,
        requiredEnv: server.requiredEnv,
        inlineSecrets: server.inlineSecrets.map(({ field, key }) => ({
          field,
          key,
        })),
        shadowed: server.shadowed.map(({ source }) => source),
        ...(server.config.disabled === true
          ? { disabledInSource: true as const }
          : {}),
        availability: listing.availability,
        tools: listing.tools,
      };
    }),
    skills: discovered.skills.map(({ name, description, path: file }) => ({
      name,
      description,
      path: file,
    })),
    skipped: discovered.skipped,
    searched: discovered.searched.map(({ file, present }) => ({
      file,
      present,
    })),
  };
}
