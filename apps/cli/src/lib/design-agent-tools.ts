import {
  buildAgentToolsManifest,
  listMcpServerTools,
  missingRequiredEnv,
  type AgentToolsManifest,
  type DiscoveredAgentTools,
  type McpToolLister,
} from "@boboddy/worker";
import type { BaseReporter } from "./reporter-types";

/**
 * The design preflight's tool-discovery step (D12–D14): find the MCP servers
 * and skills the repository defines, start each server on the host to list
 * its tools, and write the result as `discovered-tools.json` outside the
 * repository for the designer to read.
 *
 * Nothing here is fatal. A server missing a `requiredEnv` variable is not
 * started; a server that fails or times out is recorded; and if the step
 * itself fails, the session continues without a manifest.
 */

export interface AgentToolsPorts {
  /** Run repo discovery (`discoverRepoAgentTools`) on the project root. */
  discoverAgentTools(): Promise<DiscoveredAgentTools>;
  /** `process.env` merged with `.boboddy/.env`, which wins. */
  readToolEnv(): Promise<Record<string, string>>;
  /** Starts, lists and stops one server. */
  mcpToolLister: McpToolLister;
  /** Persist the manifest for `owner/slug`; returns its absolute path. */
  writeAgentToolsManifest(input: {
    owner: string;
    slug: string;
    manifest: AgentToolsManifest;
  }): Promise<string>;
}

export function announceMcpToolListing(count: number): string {
  return count === 1
    ? "Starting 1 MCP server from your repo to list its tools…"
    : `Starting ${String(count)} MCP servers from your repo to list their tools…`;
}

/**
 * Discover, list and write the manifest. Resolves to the manifest's path, or
 * `null` when it could not be written.
 */
export async function ensureAgentToolsManifest(input: {
  project: string;
  owner: string;
  slug: string;
  reporter: BaseReporter;
  ports: AgentToolsPorts;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<string | null> {
  const { reporter, ports } = input;
  try {
    const [discovered, env] = await Promise.all([
      ports.discoverAgentTools(),
      ports.readToolEnv(),
    ]);

    const startable = discovered.servers.filter(
      (server) => missingRequiredEnv(server, env).length === 0,
    );
    const task =
      startable.length > 0
        ? reporter.startActivity(announceMcpToolListing(startable.length))
        : undefined;
    const listings = await listMcpServerTools({
      servers: discovered.servers,
      env,
      lister: ports.mcpToolLister,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

    const manifest = buildAgentToolsManifest({
      project: input.project,
      generatedAt: (input.now ?? (() => new Date()))(),
      discovered,
      listings,
    });
    const listed = manifest.servers.filter(
      (server) => server.availability.status === "available",
    ).length;
    task?.succeed(
      `Listed the tools of ${String(listed)} of ${String(startable.length)} MCP server(s)`,
    );
    for (const server of manifest.servers) {
      if (server.availability.status !== "available") {
        reporter.warn(
          `MCP server ${server.name} (${server.source}): ${server.availability.status}: ${server.availability.reason}`,
        );
      }
    }

    const manifestPath = await ports.writeAgentToolsManifest({
      owner: input.owner,
      slug: input.slug,
      manifest,
    });
    reporter.success(
      `Found ${String(manifest.servers.length)} MCP server(s) and ${String(manifest.skills.length)} skill(s) in this repository`,
    );
    return manifestPath;
  } catch (error) {
    reporter.warn(
      "Could not record this repository's MCP servers and skills for the " +
        `designer: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
