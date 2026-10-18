import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { discoverRepoAgentTools } from "../../../../src/project/agent-tools/infra/discover-repo-agent-tools";

const EVERY_FORMAT_FIXTURE = path.join(
  import.meta.dir,
  "fixtures",
  "every-format",
);

describe("discoverRepoAgentTools on a repo using every format", () => {
  test("normalizes every server, applies precedence and reports what it skipped", async () => {
    const tools = await discoverRepoAgentTools(EVERY_FORMAT_FIXTURE);
    expect({
      servers: tools.servers,
      skills: tools.skills,
      skipped: tools.skipped,
      searched: tools.searched.map(({ file, present }) => ({ file, present })),
    }).toMatchSnapshot();
  });
});

describe("discoverRepoAgentTools", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "agent-tools-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function write(file: string, content: string | object) {
    const filePath = path.join(repo, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }

  const serverNamed = async (name: string) =>
    (await discoverRepoAgentTools(repo)).servers.find(
      (server) => server.name === name,
    );

  test("an empty repo has nothing and lists every file searched", async () => {
    const tools = await discoverRepoAgentTools(repo);
    expect(tools.servers).toEqual([]);
    expect(tools.skills).toEqual([]);
    expect(tools.skipped).toEqual([]);
    expect(tools.searched.map(({ file }) => file)).toEqual([
      ".opencode/opencode.json",
      ".opencode/opencode.jsonc",
      "opencode.json",
      "opencode.jsonc",
      ".mcp.json",
      ".cursor/mcp.json",
      ".vscode/mcp.json",
      ".codex/config.toml",
    ]);
    expect(tools.searched.every(({ present }) => !present)).toBe(true);
    expect(tools.searched[0]?.path).toBe(
      path.join(repo, ".opencode", "opencode.json"),
    );
  });

  test("the first file to define a name wins, in D15 order", async () => {
    await write(".codex/config.toml", '[mcp_servers.db]\ncommand = "codex"\n');
    await write(".vscode/mcp.json", {
      servers: { db: { type: "stdio", command: "vscode" } },
    });
    await write(".cursor/mcp.json", {
      mcpServers: { db: { command: "cursor" } },
    });
    await write(".mcp.json", { mcpServers: { db: { command: "claude" } } });
    await write("opencode.jsonc", {
      mcp: { servers: { db: { type: "local", command: ["root"] } } },
    });

    const db = await serverNamed("db");
    expect(db?.source).toBe("opencode.jsonc");
    expect(db?.config).toEqual({ type: "local", command: ["root"] });
    expect(db?.shadowed).toEqual([
      { source: ".mcp.json" },
      { source: ".cursor/mcp.json" },
      { source: ".vscode/mcp.json" },
      { source: ".codex/config.toml" },
    ]);
  });

  test("a skipped definition does not shadow a usable one further down", async () => {
    await write(".vscode/mcp.json", {
      servers: {
        db: { type: "stdio", command: "x", args: ["${workspaceFolder}"] },
      },
    });
    await write(".codex/config.toml", '[mcp_servers.db]\ncommand = "codex"\n');

    const tools = await discoverRepoAgentTools(repo);
    expect(tools.servers.map(({ name, source }) => ({ name, source }))).toEqual(
      [{ name: "db", source: ".codex/config.toml" }],
    );
    expect(tools.skipped).toEqual([
      {
        kind: "server",
        source: ".vscode/mcp.json",
        name: "db",
        reason: "unsupported variable ${workspaceFolder}",
      },
    ]);
  });

  describe("variables", () => {
    test("${VAR}, ${env:VAR}, ${VAR:-default} and {env:VAR} all become {env:VAR}", async () => {
      await write(".mcp.json", {
        mcpServers: {
          api: {
            command: "api-mcp",
            args: ["--region=${REGION:-us-east-1}"],
            env: {
              A: "${A_TOKEN}",
              B: "${env:B_URL}",
              C: "{env:C_KEY}",
              D: "prefix-${A_TOKEN}-suffix",
            },
          },
        },
      });

      const api = await serverNamed("api");
      expect(api?.config).toEqual({
        type: "local",
        command: ["api-mcp", "--region={env:REGION}"],
        environment: {
          A: "{env:A_TOKEN}",
          B: "{env:B_URL}",
          C: "{env:C_KEY}",
          D: "prefix-{env:A_TOKEN}-suffix",
        },
      });
      expect(api?.requiredEnv).toEqual(["A_TOKEN", "B_URL", "C_KEY", "REGION"]);
    });

    test("variables in a url and headers are collected too", async () => {
      await write(".cursor/mcp.json", {
        mcpServers: {
          remote: {
            url: "https://${HOST}/mcp",
            headers: { Authorization: "Bearer ${env:API_TOKEN}" },
          },
        },
      });

      const remote = await serverNamed("remote");
      expect(remote?.config).toEqual({
        type: "remote",
        url: "https://{env:HOST}/mcp",
        headers: { Authorization: "Bearer {env:API_TOKEN}" },
      });
      expect(remote?.requiredEnv).toEqual(["API_TOKEN", "HOST"]);
    });

    test("a server reading a VS Code inputs prompt is skipped", async () => {
      await write(".vscode/mcp.json", {
        inputs: [{ type: "promptString", id: "key", password: true }],
        servers: {
          prompted: {
            type: "http",
            url: "https://x.test/mcp",
            headers: { "X-Key": "${input:key}" },
          },
        },
      });

      const tools = await discoverRepoAgentTools(repo);
      expect(tools.servers).toEqual([]);
      expect(tools.skipped).toEqual([
        {
          kind: "server",
          source: ".vscode/mcp.json",
          name: "prompted",
          reason: "uses VS Code inputs prompts",
        },
      ]);
    });
  });

  describe("inline secrets", () => {
    const SECRET_VALUES = [
      "ghp_0123456789abcdefghijABCDEFGHIJ012345",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "hunter2-correct-horse",
      "Bearer s3cr3t-v4lu3-xyz",
      "client-secret-value-123",
    ];

    test("credential-looking literals are dropped and recorded by key only", async () => {
      await write(".mcp.json", {
        mcpServers: {
          github: {
            command: "github-mcp",
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: SECRET_VALUES[0],
              ANTHROPIC: SECRET_VALUES[1],
              DB_PASSWORD: SECRET_VALUES[2],
              LOG_LEVEL: "debug",
              CONFIG_PATH: "/etc/github-mcp/config.json",
              TOKEN_FROM_ENV: "${GITHUB_TOKEN}",
            },
          },
          remote: {
            type: "http",
            url: "https://remote.test/mcp",
            headers: {
              Authorization: SECRET_VALUES[3],
              "X-Region": "eu",
            },
          },
        },
      });
      await write("opencode.json", {
        mcp: {
          servers: {
            oauth: {
              type: "remote",
              url: "https://oauth.test/mcp",
              oauth: {
                client_id: "boboddy",
                client_secret: SECRET_VALUES[4],
              },
            },
          },
        },
      });

      const tools = await discoverRepoAgentTools(repo);
      const serialized = JSON.stringify(tools);
      for (const value of SECRET_VALUES) {
        expect(serialized).not.toContain(value);
        expect(serialized).not.toContain(value.replace(/^Bearer /u, ""));
      }

      const byName = Object.fromEntries(
        tools.servers.map((server) => [server.name, server]),
      );
      expect(byName["github"]?.config).toEqual({
        type: "local",
        command: ["github-mcp"],
        environment: {
          LOG_LEVEL: "debug",
          CONFIG_PATH: "/etc/github-mcp/config.json",
          TOKEN_FROM_ENV: "{env:GITHUB_TOKEN}",
        },
      });
      expect(byName["github"]?.inlineSecrets).toEqual([
        {
          field: "environment",
          key: "GITHUB_PERSONAL_ACCESS_TOKEN",
          inlineSecret: true,
        },
        { field: "environment", key: "ANTHROPIC", inlineSecret: true },
        { field: "environment", key: "DB_PASSWORD", inlineSecret: true },
      ]);
      expect(byName["remote"]?.config).toEqual({
        type: "remote",
        url: "https://remote.test/mcp",
        headers: { "X-Region": "eu" },
      });
      expect(byName["remote"]?.inlineSecrets).toEqual([
        { field: "headers", key: "Authorization", inlineSecret: true },
      ]);
      expect(byName["oauth"]?.config).toEqual({
        type: "remote",
        url: "https://oauth.test/mcp",
        oauth: { client_id: "boboddy" },
      });
      expect(byName["oauth"]?.inlineSecrets).toEqual([
        { field: "oauth", key: "client_secret", inlineSecret: true },
      ]);
    });

    test("a literal secret in the command or url skips the server without echoing it", async () => {
      await write(".mcp.json", {
        mcpServers: {
          flagged: {
            command: "npx",
            args: ["-y", "some-mcp", "--api-key", "abcd1234efgh5678"],
          },
          assigned: { command: "some-mcp", args: ["--token=abcd1234efgh5678"] },
          query: {
            type: "http",
            url: "https://x.test/mcp?api_key=abcd1234efgh5678",
          },
          userinfo: {
            type: "http",
            url: "https://user:abcd1234efgh5678@x.test/mcp",
          },
        },
      });

      const tools = await discoverRepoAgentTools(repo);
      expect(tools.servers).toEqual([]);
      expect(JSON.stringify(tools)).not.toContain("abcd1234efgh5678");
      expect(
        tools.skipped.map(({ name, reason }) => ({ name, reason })),
      ).toEqual([
        { name: "flagged", reason: "inline secret in command (--api-key)" },
        { name: "assigned", reason: "inline secret in command (--token)" },
        {
          name: "query",
          reason: "inline secret in url (query parameter api_key)",
        },
        { name: "userinfo", reason: "inline secret in url (url)" },
      ]);
    });
  });

  describe("unusable files and entries", () => {
    test("an unparseable file is skipped and later files are still read", async () => {
      await write(".opencode/opencode.json", "{ not json");
      await write(".codex/config.toml", "[mcp_servers.db\n");
      await write(".mcp.json", { mcpServers: { ok: { command: "ok" } } });

      const tools = await discoverRepoAgentTools(repo);
      expect(tools.servers.map(({ name }) => name)).toEqual(["ok"]);
      expect(
        tools.skipped.map(({ source, name, reason }) => ({
          source,
          name,
          startsWithParseError: reason.startsWith("parse error: "),
        })),
      ).toEqual([
        {
          source: ".opencode/opencode.json",
          name: null,
          startsWithParseError: true,
        },
        {
          source: ".codex/config.toml",
          name: null,
          startsWithParseError: true,
        },
      ]);
    });

    test("unsupported transports and invalid entries are skipped with a reason", async () => {
      await write(".mcp.json", {
        mcpServers: {
          websocket: { type: "ws", url: "wss://x.test" },
          empty: {},
          noCommand: { type: "stdio" },
          envFile: { command: "x", envFile: ".env" },
        },
      });
      await write("opencode.json", {
        mcp: { servers: { bad: { type: "local", command: [] } } },
      });

      const tools = await discoverRepoAgentTools(repo);
      expect(tools.servers).toEqual([]);
      expect(
        tools.skipped.map(({ name, reason }) => ({
          name,
          reason: reason.split("\n")[0],
        })),
      ).toEqual([
        {
          name: "bad",
          reason:
            "invalid server: ✖ Too small: expected array to have >=1 items",
        },
        { name: "websocket", reason: 'unsupported transport "ws"' },
        { name: "empty", reason: "server has neither a command nor a url" },
        { name: "noCommand", reason: "stdio server has no command" },
        { name: "envFile", reason: "envFile is not supported" },
      ]);
    });

    test("a skill file without a description is skipped", async () => {
      await write(".claude/skills/thin/SKILL.md", "---\nname: thin\n---\n");
      await write(".claude/skills/yaml/SKILL.md", "---\nname: [oops\n---\n");

      const tools = await discoverRepoAgentTools(repo);
      expect(tools.skills).toEqual([]);
      expect(
        tools.skipped.map(({ kind, name, source }) => ({ kind, name, source })),
      ).toEqual([
        { kind: "skill", name: "thin", source: ".claude/skills/thin/SKILL.md" },
        { kind: "skill", name: "yaml", source: ".claude/skills/yaml/SKILL.md" },
      ]);
    });
  });
});
