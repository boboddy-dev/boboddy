import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { discoverRepoAgentTools } from "../../../../src/project/agent-tools/infra/discover-repo-agent-tools";
import {
  McpServerRefNotFoundError,
  resolveStepMcpServers,
} from "../../../../src/work/task/infra/mcp-server-ref-resolver";

function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("resolveStepMcpServers", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-ref-workspace-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function write(file: string, content: string | object) {
    const filePath = path.join(workspace, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }

  const resolveWith = async (
    servers: Parameters<typeof resolveStepMcpServers>[0]["servers"],
  ) =>
    resolveStepMcpServers({
      servers,
      tools: await discoverRepoAgentTools(workspace),
    });

  test("returns null when the step declares nothing and the repo defines nothing", async () => {
    expect(await resolveWith(null)).toEqual({
      servers: null,
      resolvedRefs: [],
      disabledServers: [],
    });
    expect((await resolveWith(undefined)).servers).toBeNull();
  });

  test("passes inline entries through unchanged", async () => {
    const { servers } = await resolveWith({
      playwright: { type: "local", command: ["npx", "@playwright/mcp"] },
      docs: { type: "remote", url: "https://example.test/mcp" },
    });
    expect(servers).toEqual({
      playwright: { type: "local", command: ["npx", "@playwright/mcp"] },
      docs: { type: "remote", url: "https://example.test/mcp" },
    });
  });

  test("resolves refs from any discovered format and reports where, without the definition", async () => {
    await write(".opencode/opencode.json", {
      mcp: { servers: { postgres: { type: "local", command: ["pg-mcp"] } } },
    });
    await write(".mcp.json", {
      mcpServers: {
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: {
            Authorization: "Bearer ghp_0123456789abcdefghijABCDEFGHIJ0123",
          },
        },
      },
    });
    await write(
      ".codex/config.toml",
      '[mcp_servers.docs]\ncommand = "docs-mcp"\n',
    );

    const { servers, resolvedRefs } = await resolveWith({
      db: { type: "ref", name: "postgres" },
      github: { type: "ref" },
      docs: { type: "ref", codemode: true },
    });

    expect(servers).toEqual({
      db: { type: "local", command: ["pg-mcp"] },
      github: { type: "remote", url: "https://api.githubcopilot.com/mcp/" },
      docs: { type: "local", command: ["docs-mcp"], codemode: true },
      postgres: { type: "local", command: ["pg-mcp"], disabled: true },
    });
    expect(resolvedRefs).toEqual([
      {
        key: "db",
        lookupName: "postgres",
        source: ".opencode/opencode.json",
        type: "local",
        inlineSecrets: [],
        requiredEnv: [],
      },
      {
        key: "github",
        lookupName: "github",
        source: ".mcp.json",
        type: "remote",
        inlineSecrets: [
          { field: "headers", key: "Authorization", inlineSecret: true },
        ],
        requiredEnv: [],
      },
      {
        key: "docs",
        lookupName: "docs",
        source: ".codex/config.toml",
        type: "local",
        inlineSecrets: [],
        requiredEnv: [],
      },
    ]);
  });

  test("applies the ref's shared fields on top of the resolved entry", async () => {
    await write(".opencode/opencode.json", {
      mcp: {
        servers: {
          db: {
            type: "local",
            command: ["pg-mcp"],
            disabled: true,
            timeout: { startup: 1000 },
            protocol: "legacy",
          },
        },
      },
    });

    const { servers } = await resolveWith({
      db: {
        type: "ref",
        disabled: false,
        codemode: true,
        timeout: { execution: 5000 },
      },
    });
    expect(servers).toEqual({
      db: {
        type: "local",
        command: ["pg-mcp"],
        disabled: false,
        codemode: true,
        timeout: { execution: 5000 },
        protocol: "legacy",
      },
    });
  });

  test("drops the ref's name and reports its required env", async () => {
    await write(".opencode/opencode.json", {
      mcp: {
        servers: {
          datadog: {
            type: "local",
            command: ["dd-mcp"],
            environment: {
              DD_API_KEY: "{env:DATADOG_API_KEY}",
              DD_SITE: "{env:DATADOG_SITE}",
            },
          },
        },
      },
    });

    const { servers, resolvedRefs } = await resolveWith({
      dd: {
        type: "ref",
        name: "datadog",
        codemode: true,
      },
    });

    expect(servers).toEqual({
      dd: {
        type: "local",
        command: ["dd-mcp"],
        environment: {
          DD_API_KEY: "{env:DATADOG_API_KEY}",
          DD_SITE: "{env:DATADOG_SITE}",
        },
        codemode: true,
      },
      datadog: {
        type: "local",
        command: ["dd-mcp"],
        environment: {
          DD_API_KEY: "{env:DATADOG_API_KEY}",
          DD_SITE: "{env:DATADOG_SITE}",
        },
        disabled: true,
      },
    });
    expect(servers?.["dd"]).not.toHaveProperty("name");
    expect(resolvedRefs).toHaveLength(1);
    expect(resolvedRefs[0]).toMatchObject({
      key: "dd",
      requiredEnv: ["DATADOG_API_KEY", "DATADOG_SITE"],
    });
  });

  test("converts v1 OpenCode entries to v2", async () => {
    await write(".opencode/opencode.json", {
      mcp: {
        postgres: {
          type: "local",
          command: ["pg-mcp"],
          cwd: "tools",
          environment: { DATABASE_URI: "{env:DATABASE_URI}" },
          enabled: false,
          timeout: 15000,
        },
        tch: { type: "local", command: ["tch"], enabled: true },
        sentry: {
          type: "remote",
          url: "https://sentry.test/mcp",
          oauth: {
            clientId: "id",
            redirectUri: "http://127.0.0.1/cb",
            callbackPort: 19876,
            scope: "read",
          },
        },
      },
    });

    const { servers } = await resolveWith({
      postgres: { type: "ref" },
      tch: { type: "ref" },
      sentry: { type: "ref" },
    });
    expect(servers).toEqual({
      postgres: {
        type: "local",
        command: ["pg-mcp"],
        cwd: "tools",
        environment: { DATABASE_URI: "{env:DATABASE_URI}" },
        disabled: true,
        timeout: { startup: 15000 },
      },
      tch: { type: "local", command: ["tch"] },
      sentry: {
        type: "remote",
        url: "https://sentry.test/mcp",
        oauth: {
          client_id: "id",
          redirect_uri: "http://127.0.0.1/cb",
          callback_port: 19876,
          scope: "read",
        },
      },
    });
  });

  test("a v1 toggle-only entry defines nothing, so a later file can", async () => {
    await write(".opencode/opencode.json", { mcp: { db: { enabled: true } } });
    await write(".mcp.json", { mcpServers: { db: { command: "claude-db" } } });

    const { servers } = await resolveWith({ db: { type: "ref" } });
    expect(servers).toEqual({ db: { type: "local", command: ["claude-db"] } });
  });

  describe("trimming", () => {
    test("every discovered server the step does not name is disabled", async () => {
      await write(".opencode/opencode.jsonc", {
        mcp: {
          servers: {
            postgres: { type: "local", command: ["pg-mcp"] },
            sentry: { type: "remote", url: "https://sentry.test/mcp" },
          },
        },
      });
      await write(".mcp.json", {
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp"] },
        },
      });

      expect(
        await resolveWith({
          sentry: { type: "ref" },
          inline: { type: "local", command: ["inline"] },
        }),
      ).toEqual({
        servers: {
          sentry: { type: "remote", url: "https://sentry.test/mcp" },
          inline: { type: "local", command: ["inline"] },
          postgres: { type: "local", command: ["pg-mcp"], disabled: true },
          playwright: {
            type: "local",
            command: ["npx", "@playwright/mcp"],
            disabled: true,
          },
        },
        resolvedRefs: [
          {
            key: "sentry",
            lookupName: "sentry",
            source: ".opencode/opencode.jsonc",
            type: "remote",
            inlineSecrets: [],
            requiredEnv: [],
          },
        ],
        disabledServers: ["postgres", "playwright"],
      });
    });

    test("a step with no servers still disables every discovered one", async () => {
      await write(".opencode/opencode.json", {
        mcp: { servers: { postgres: { type: "local", command: ["pg-mcp"] } } },
      });

      const { servers, disabledServers } = await resolveWith(null);
      expect(servers).toEqual({
        postgres: { type: "local", command: ["pg-mcp"], disabled: true },
      });
      expect(disabledServers).toEqual(["postgres"]);
    });

    test("an inline step server replaces a discovered one with the same name", async () => {
      await write(".mcp.json", { mcpServers: { db: { command: "repo-db" } } });

      const { servers, disabledServers } = await resolveWith({
        db: { type: "local", command: ["step-db"] },
      });
      expect(servers).toEqual({ db: { type: "local", command: ["step-db"] } });
      expect(disabledServers).toEqual([]);
    });
  });

  test("a missing ref throws an error listing every repo file searched", async () => {
    await write(".mcp.json", { mcpServers: { other: { command: "x" } } });

    const tools = await discoverRepoAgentTools(workspace);
    const error = thrownBy(() =>
      resolveStepMcpServers({
        servers: { db: { type: "ref", name: "postgres" } },
        tools,
      }),
    );

    expect(error).toBeInstanceOf(McpServerRefNotFoundError);
    const notFound = error as McpServerRefNotFoundError;
    expect(notFound.ref).toBe("db");
    expect(notFound.lookupName).toBe("postgres");
    expect(notFound.message).toContain('"db" (name "postgres")');
    expect(notFound.message).toContain(
      `.mcp.json (${path.join(workspace, ".mcp.json")})`,
    );
    expect(notFound.message).toContain(".codex/config.toml (not present)");
    expect(notFound.searched).toHaveLength(8);
    expect(notFound.message).not.toContain("global");
  });

  test("a missing ref names why a same-named definition was skipped", async () => {
    await write(".vscode/mcp.json", {
      servers: {
        db: { type: "stdio", command: "db", env: { KEY: "${input:key}" } },
      },
    });

    const tools = await discoverRepoAgentTools(workspace);
    const error = thrownBy(() =>
      resolveStepMcpServers({ servers: { db: { type: "ref" } }, tools }),
    );
    expect(error).toBeInstanceOf(McpServerRefNotFoundError);
    expect(error.message).toContain(
      "It is defined in .vscode/mcp.json but could not be used: uses VS Code inputs prompts.",
    );
  });
});
