import { describe, expect, test } from "bun:test";
import type { OpenCodeMcpServerConfig } from "../../../../src/common/contracts/opencode-mcp";
import {
  MCP_CANARY_ISSUE_URL,
  findMcpCanaryEntries,
  matchMcpCanary,
  mcpCanaryRegistry,
  type McpCanaryRegistryEntry,
} from "../../../../src/work/step-execution/application/mcp-canary-registry";

const playwrightServer: OpenCodeMcpServerConfig = {
  type: "local",
  command: ["npx", "-y", "@playwright/mcp@latest", "--headless"],
};

const postgresServer: OpenCodeMcpServerConfig = {
  type: "local",
  command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
  environment: { DATABASE_URI: "postgres://localhost:6429/boboddy" },
};

describe("matchMcpCanary", () => {
  test.concurrent(
    "matches Playwright on its command args and qualifies the tool name",
    () => {
      expect(matchMcpCanary("browser", playwrightServer)).toEqual({
        kind: "matched",
        entryId: "playwright",
        canary: {
          tool: "browser_browser_navigate",
          args: { url: "about:blank" },
        },
      });
    },
  );

  test.concurrent(
    "matches Postgres on its server name and qualifies the tool name",
    () => {
      expect(matchMcpCanary("postgres", postgresServer)).toEqual({
        kind: "matched",
        entryId: "postgres",
        canary: { tool: "postgres_list_schemas", args: {} },
      });
    },
  );

  test.concurrent("matches server names case-insensitively", () => {
    const match = matchMcpCanary("Postgres", postgresServer);

    expect(match).toEqual({
      kind: "matched",
      entryId: "postgres",
      canary: { tool: "Postgres_list_schemas", args: {} },
    });
  });

  test.concurrent("matches command args case-insensitively", () => {
    const match = matchMcpCanary("browser", {
      type: "local",
      command: ["npx", "-y", "@PlayWright/MCP@latest"],
    });

    expect(match).toMatchObject({ kind: "matched", entryId: "playwright" });
  });

  test.concurrent("reports unverified when no entry matches", () => {
    expect(
      matchMcpCanary("github", {
        type: "local",
        command: ["docker", "run", "-i", "ghcr.io/github/github-mcp-server"],
      }),
    ).toEqual({ kind: "unverified", reason: "no-match" });
  });

  test.concurrent(
    "never matches a remote server, even when its name would match",
    () => {
      expect(
        matchMcpCanary("postgres", {
          type: "remote",
          url: "https://mcp.example.com/postgres",
        }),
      ).toEqual({ kind: "unverified", reason: "no-match" });
    },
  );

  test.concurrent("never matches a bare enabled override", () => {
    expect(matchMcpCanary("postgres", { enabled: true })).toEqual({
      kind: "unverified",
      reason: "no-match",
    });
  });

  test.concurrent(
    "reports unverified and logs an error when more than one entry matches",
    () => {
      const ambiguousRegistry: McpCanaryRegistryEntry[] = [
        {
          id: "first",
          matcher: { field: "name", pattern: /postgres/ },
          canary: { tool: "list_schemas", args: {} },
        },
        {
          id: "second",
          matcher: { field: "args", pattern: /postgres-mcp/ },
          canary: { tool: "list_tables", args: {} },
        },
      ];
      const logged: { message: string; details: Record<string, unknown> }[] =
        [];

      const match = matchMcpCanary("postgres", postgresServer, {
        registry: ambiguousRegistry,
        logError: (message, details) => {
          logged.push({ message, details });
        },
      });

      expect(match).toEqual({ kind: "unverified", reason: "ambiguous-match" });
      expect(logged).toHaveLength(1);
      expect(logged[0]?.message).toContain(MCP_CANARY_ISSUE_URL);
      expect(logged[0]?.details).toEqual({
        serverName: "postgres",
        matchedEntryIds: ["first", "second"],
      });
    },
  );

  test.concurrent(
    "does not throw when an ambiguous match is found with the default logger",
    () => {
      const ambiguousRegistry: McpCanaryRegistryEntry[] = [
        {
          id: "a",
          matcher: { field: "name", pattern: /pg/ },
          canary: { tool: "one", args: {} },
        },
        {
          id: "b",
          matcher: { field: "name", pattern: /^pg$/ },
          canary: { tool: "two", args: {} },
        },
      ];

      expect(
        matchMcpCanary(
          "pg",
          { type: "local", command: ["pgmcp"] },
          { registry: ambiguousRegistry },
        ),
      ).toEqual({ kind: "unverified", reason: "ambiguous-match" });
    },
  );

  test.concurrent(
    "does not leak regex lastIndex state between calls for global patterns",
    () => {
      const registry: McpCanaryRegistryEntry[] = [
        {
          id: "sticky",
          matcher: { field: "args", pattern: /mcp/g },
          canary: { tool: "ping", args: {} },
        },
      ];
      const config: OpenCodeMcpServerConfig = {
        type: "local",
        command: ["mcp-mcp", "mcp"],
      };

      expect(matchMcpCanary("a", config, { registry }).kind).toBe("matched");
      expect(matchMcpCanary("a", config, { registry }).kind).toBe("matched");
      expect(matchMcpCanary("a", config, { registry }).kind).toBe("matched");
    },
  );
});

/**
 * A battery of realistic server configs. Every registry entry must be matched by
 * at least one of these, and no single config may match two entries — that pair
 * of assertions is what catches an accidentally ambiguous new entry.
 */
const exampleServerConfigs: {
  label: string;
  name: string;
  config: OpenCodeMcpServerConfig;
}[] = [
  {
    label: "playwright via npx, generic server name",
    name: "browser",
    config: {
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@latest", "--headless"],
    },
  },
  {
    label: "playwright via bunx, pinned and isolated",
    name: "Playwright",
    config: {
      type: "local",
      command: ["bunx", "@playwright/mcp@0.0.41", "--isolated"],
    },
  },
  {
    label: "postgres via uvx",
    name: "postgres",
    config: {
      type: "local",
      command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
      environment: { DATABASE_URI: "postgres://localhost:6429/boboddy" },
    },
  },
  {
    label: "postgres with a capitalised server name",
    name: "Postgres",
    config: { type: "local", command: ["uvx", "postgres-mcp"] },
  },
  {
    label: "github via docker",
    name: "github",
    config: {
      type: "local",
      command: [
        "docker",
        "run",
        "-i",
        "--rm",
        "ghcr.io/github/github-mcp-server",
      ],
      environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "token" },
    },
  },
  {
    label: "filesystem via npx",
    name: "filesystem",
    config: {
      type: "local",
      command: [
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/workspaces/repo",
      ],
    },
  },
  {
    label: "minio via bun",
    name: "minio",
    config: { type: "local", command: ["bun", "run", "minio-mcp"] },
  },
  {
    label: "sentry as a remote server",
    name: "sentry",
    config: { type: "remote", url: "https://mcp.sentry.dev/mcp" },
  },
  {
    label: "an inherited server toggled off",
    name: "postgres",
    config: { enabled: false },
  },
];

describe("mcpCanaryRegistry self-check", () => {
  test.concurrent("entry ids are unique", () => {
    const ids = mcpCanaryRegistry.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test.concurrent("canary tool names are bare, not already qualified", () => {
    for (const entry of mcpCanaryRegistry) {
      expect(entry.canary.tool.startsWith(`${entry.id}_`)).toBe(false);
    }
  });

  test.concurrent(
    "no example server config matches more than one entry",
    () => {
      const ambiguous = exampleServerConfigs
        .map((example) => ({
          label: example.label,
          matchedEntryIds: findMcpCanaryEntries(
            example.name,
            example.config,
          ).map((entry) => entry.id),
        }))
        .filter((result) => result.matchedEntryIds.length > 1);

      expect(ambiguous).toEqual([]);
    },
  );

  test.concurrent(
    "every registry entry is exercised by at least one example",
    () => {
      const covered = new Set(
        exampleServerConfigs.flatMap((example) =>
          findMcpCanaryEntries(example.name, example.config).map(
            (entry) => entry.id,
          ),
        ),
      );
      const uncovered = mcpCanaryRegistry
        .map((entry) => entry.id)
        .filter((id) => !covered.has(id));

      expect(uncovered).toEqual([]);
    },
  );

  test.concurrent(
    "no matcher pattern smuggles an OR into a single entry",
    () => {
      // Alternation inside one pattern is the combined matcher the registry
      // design forbids: it hides behind a single entry, so the ambiguity check
      // above can never see the two things it really matches.
      const withAlternation = mcpCanaryRegistry
        .filter((entry) => entry.matcher.pattern.source.includes("|"))
        .map((entry) => entry.id);

      expect(withAlternation).toEqual([]);
    },
  );

  test.concurrent(
    "seeds Playwright matched by args and Postgres matched by name",
    () => {
      const fieldById = Object.fromEntries(
        mcpCanaryRegistry.map((entry) => [entry.id, entry.matcher.field]),
      );

      expect(fieldById["playwright"]).toBe("args");
      expect(fieldById["postgres"]).toBe("args");
    },
  );
});
