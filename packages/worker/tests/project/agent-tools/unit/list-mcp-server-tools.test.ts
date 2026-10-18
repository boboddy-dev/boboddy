import { describe, expect, test } from "bun:test";
import {
  listMcpServerTools,
  type McpToolLister,
} from "../../../../src/project/agent-tools/application/list-mcp-server-tools";
import {
  agentToolsManifestPath,
  AGENT_TOOLS_MANIFEST_CAVEATS,
  buildAgentToolsManifest,
} from "../../../../src/project/agent-tools/domain/agent-tools-manifest";
import type {
  DiscoveredAgentTools,
  DiscoveredMcpServer,
} from "../../../../src/project/agent-tools/domain/discovered-agent-tools";

function server(name: string, requiredEnv: string[] = []): DiscoveredMcpServer {
  return {
    name,
    source: ".mcp.json",
    transport: "local",
    config: { type: "local", command: ["run", name] },
    requiredEnv,
    inlineSecrets: [],
    shadowed: [],
  };
}

const QUERY_TOOL = {
  name: "query",
  description: "Run a read-only query",
  inputSchema: { type: "object" },
  readOnlyHint: true,
};

describe("listMcpServerTools", () => {
  test.concurrent(
    "never starts a server missing a requiredEnv var",
    async () => {
      const started: string[] = [];
      const lister: McpToolLister = {
        listTools: ({ server: s }) => {
          started.push(s.name);
          return Promise.resolve([QUERY_TOOL]);
        },
      };

      const listings = await listMcpServerTools({
        servers: [server("db", ["DB_URL", "DB_ROLE"]), server("fs")],
        env: { DB_ROLE: "" },
        lister,
      });

      expect(started).toEqual(["fs"]);
      expect(listings.get("db")).toEqual({
        availability: {
          status: "unavailable",
          reason: "missing DB_URL, DB_ROLE",
        },
        tools: [],
      });
      expect(listings.get("fs")).toEqual({
        availability: { status: "available" },
        tools: [QUERY_TOOL],
      });
    },
  );

  test.concurrent(
    "times out a hung server, aborts it, and still lists the rest concurrently",
    async () => {
      let aborted = false;
      const lister: McpToolLister = {
        listTools: ({ server: s, signal }) =>
          s.name === "hung"
            ? new Promise((_, reject) => {
                signal.addEventListener("abort", () => {
                  aborted = true;
                  reject(new Error("aborted"));
                });
              })
            : Promise.resolve([QUERY_TOOL]),
      };

      const started = Date.now();
      const listings = await listMcpServerTools({
        servers: [server("hung"), server("ok")],
        env: {},
        lister,
        timeoutMs: 50,
      });

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(aborted).toBe(true);
      expect(listings.get("hung")?.availability).toEqual({
        status: "failed",
        reason: "timed out after 0.05s",
      });
      expect(listings.get("ok")?.availability).toEqual({ status: "available" });
    },
  );

  test.concurrent(
    "records a failure with every env value put back as a placeholder",
    async () => {
      const lister: McpToolLister = {
        listTools: () =>
          Promise.reject(
            new Error("GET https://x.dev/?key=sk-123456 returned 401"),
          ),
      };

      const listings = await listMcpServerTools({
        servers: [server("api", ["API_KEY"])],
        env: { API_KEY: "sk-123456" },
        lister,
      });

      expect(listings.get("api")?.availability).toEqual({
        status: "failed",
        reason: "GET https://x.dev/?key={env:API_KEY} returned 401",
      });
    },
  );
});

describe("buildAgentToolsManifest", () => {
  const discovered: DiscoveredAgentTools = {
    servers: [
      {
        ...server("db", ["DB_URL"]),
        config: {
          type: "local",
          command: ["db-mcp"],
          environment: { DB_URL: "{env:DB_URL}" },
          disabled: true,
        },
        inlineSecrets: [{ field: "headers", key: "X-Key", inlineSecret: true }],
        shadowed: [{ source: ".cursor/mcp.json" }],
      },
    ],
    skills: [
      {
        name: "triage",
        description: "Triage",
        path: ".claude/skills/triage/SKILL.md",
        shadowed: [{ path: ".agents/skills/triage/SKILL.md" }],
      },
    ],
    skipped: [
      {
        kind: "skill",
        source: ".claude/skills/x.md",
        name: null,
        reason: "skill file has no frontmatter",
      },
    ],
    searched: [{ file: ".mcp.json", path: "/repo/.mcp.json", present: true }],
  };

  test.concurrent(
    "carries names only, with the caveat and skipped entries",
    () => {
      const manifest = buildAgentToolsManifest({
        project: "acme/app",
        generatedAt: new Date("2026-10-14T00:00:00Z"),
        discovered,
        listings: new Map([
          [
            "db",
            { availability: { status: "available" }, tools: [QUERY_TOOL] },
          ],
        ]),
      });

      expect(manifest).toEqual({
        version: 1,
        generatedAt: "2026-10-14T00:00:00.000Z",
        project: "acme/app",
        caveats: AGENT_TOOLS_MANIFEST_CAVEATS,
        servers: [
          {
            name: "db",
            source: ".mcp.json",
            transport: "local",
            requiredEnv: ["DB_URL"],
            inlineSecrets: [{ field: "headers", key: "X-Key" }],
            shadowed: [".cursor/mcp.json"],
            disabledInSource: true,
            availability: { status: "available" },
            tools: [QUERY_TOOL],
          },
        ],
        skills: [
          {
            name: "triage",
            description: "Triage",
            path: ".claude/skills/triage/SKILL.md",
          },
        ],
        skipped: discovered.skipped,
        searched: [{ file: ".mcp.json", present: true }],
      });
      expect(JSON.stringify(manifest)).not.toContain("environment");
      expect(JSON.stringify(manifest)).not.toContain("/repo/");
    },
  );

  test.concurrent("lives under ~/.boboddy/projects/<owner>/<slug>", () => {
    expect(
      agentToolsManifestPath({
        homeDir: "/home/u",
        owner: "acme",
        slug: "app",
      }),
    ).toBe("/home/u/.boboddy/projects/acme/app/discovered-tools.json");
  });
});
