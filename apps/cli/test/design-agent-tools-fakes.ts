import type { DiscoveredAgentTools } from "@boboddy/worker";
import type { AgentToolsPorts } from "../src/lib/design-agent-tools";

export const FAKE_AGENT_TOOLS_MANIFEST_PATH =
  "/home/test/.boboddy/projects/acme/app/discovered-tools.json";

export const EMPTY_DISCOVERY: DiscoveredAgentTools = {
  servers: [],
  skills: [],
  skipped: [],
  searched: [],
};

/**
 * Agent-tools ports for a repository with no MCP servers or skills: nothing
 * is started, and the manifest "write" returns a fixed path.
 */
export function fakeAgentToolsPorts(
  overrides: Partial<AgentToolsPorts> = {},
): AgentToolsPorts {
  return {
    discoverAgentTools: () => Promise.resolve(EMPTY_DISCOVERY),
    readToolEnv: () => Promise.resolve({}),
    mcpToolLister: {
      listTools: () => Promise.reject(new Error("no server to list")),
    },
    writeAgentToolsManifest: () =>
      Promise.resolve(FAKE_AGENT_TOOLS_MANIFEST_PATH),
    ...overrides,
  };
}
