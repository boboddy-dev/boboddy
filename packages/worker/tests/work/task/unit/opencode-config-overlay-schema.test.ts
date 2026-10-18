import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildOpencodeContext } from "@boboddy/opencode-plugin";
import type { ResolvedOpenCodeMcpServers } from "@boboddy/sdk/opencode-mcp";
import { buildOpencodeTuiConfig } from "../../../../src/runtime/host-opencode-tui/domain/opencode-tui-config";
import { buildFakeProviderConfig } from "../../../../src/work/task/infra/fake-ai/fake-provider-config";
import { seedOpencodeConfig } from "../../../../src/work/task/infra/fake-ai/seed-opencode-config";
import {
  buildOpencodeConfigValidator,
  type ConfigSchemaCheck,
  type OpencodeConfigDocument,
} from "../../../support/opencode-config-schema";

/**
 * Every config document Boboddy hands OpenCode, validated against the pinned
 * runtime's own `Config.InfoEncoded` schema (vendored from `/openapi.json`).
 * `Config.InfoEncoded` rejects unknown top-level keys, but OpenCode itself
 * only drops them silently, so this is the only place a misspelt or v1-shaped
 * key fails loudly.
 */

const validate = buildOpencodeConfigValidator();

function expectValid(result: ConfigSchemaCheck): void {
  expect(result.errors).toBe("No errors");
  expect(result.valid).toBe(true);
}

const MCP_SERVERS: ResolvedOpenCodeMcpServers = {
  "local-fixture": {
    type: "local",
    command: ["node", "server.js"],
    environment: { TOKEN: "{env:FIXTURE_TOKEN}" },
    timeout: { catalog: 5_000, execution: 30_000 },
  },
  "my-fix.v2": {
    type: "remote",
    url: "https://mcp.example.com/sse",
    headers: { authorization: "Bearer x" },
    oauth: { client_id: "abc", scope: "read" },
    disabled: false,
    codemode: true,
  },
  "no-oauth": { type: "remote", url: "https://mcp.example.com", oauth: false },
};

describe("task overlay", () => {
  let workspacePath: string;
  let savedModel: string | undefined;

  beforeAll(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "overlay-schema-"));
    savedModel = process.env["AGENT_DEFAULT_MODEL"];
  });

  afterAll(async () => {
    if (savedModel === undefined) delete process.env["AGENT_DEFAULT_MODEL"];
    else process.env["AGENT_DEFAULT_MODEL"] = savedModel;
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function overlay(
    input: Omit<Parameters<typeof buildOpencodeContext>[0], "workspacePath">,
  ): Promise<OpencodeConfigDocument> {
    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      ...input,
    });
    return JSON.parse(opencodeConfigContent) as OpencodeConfigDocument;
  }

  test("the embedded baseline alone is valid", async () => {
    delete process.env["AGENT_DEFAULT_MODEL"];
    expectValid(validate(await overlay({ stepMcpServers: null })));
  });

  test("MCP servers, an agent prompt and a model are valid", async () => {
    process.env["AGENT_DEFAULT_MODEL"] = "anthropic/claude-sonnet-4-5";
    const document = await overlay({
      stepMcpServers: MCP_SERVERS,
      agentPromptText: "Fix the bug.",
    });
    delete process.env["AGENT_DEFAULT_MODEL"];

    expectValid(validate(document));
    expect(document).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      agents: { build: { system: "Fix the bug." } },
    });
  });

  test("the fake-AI provider override is valid", async () => {
    delete process.env["AGENT_DEFAULT_MODEL"];
    const document = await overlay({
      stepMcpServers: MCP_SERVERS,
      providerOverride: buildFakeProviderConfig("http://127.0.0.1:4097"),
    });

    expectValid(validate(document));
  });
});

describe("fake-AI seeded global config", () => {
  test("the seeded opencode.json is valid", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "seed-schema-"));
    try {
      await seedOpencodeConfig(homeDir, 4097, { fakeAiHost: "127.0.0.1" });
      const seeded = JSON.parse(
        await readFile(
          path.join(homeDir, ".config", "opencode", "opencode.json"),
          "utf8",
        ),
      ) as OpencodeConfigDocument;
      expectValid(validate(seeded));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("host TUI overlay", () => {
  test.concurrent("the pipeline-designer overlay is valid", () => {
    expectValid(
      validate(buildOpencodeTuiConfig({ description: "d", prompt: "p" })),
    );
  });
});

describe("v1-shaped overlays are rejected", () => {
  test.concurrent.each([
    [
      "v1 `permission` object",
      { permission: { "*": "allow", question: "deny" } },
      "data must NOT have additional properties",
    ],
    [
      "v1 `mcp.<name>{enabled}`",
      { mcp: { fixture: { type: "local", command: ["x"], enabled: true } } },
      "data/mcp must NOT have additional properties",
    ],
    [
      "v1 `enabled` on a v2 server entry",
      {
        mcp: {
          servers: {
            fixture: { type: "local", command: ["x"], enabled: true },
          },
        },
      },
      "data/mcp/servers/fixture must NOT have additional properties",
    ],
    [
      "v1 numeric MCP `timeout`",
      {
        mcp: {
          servers: { fixture: { type: "local", command: ["x"], timeout: 5 } },
        },
      },
      "data/mcp/servers/fixture/timeout must be object",
    ],
    [
      "v1 `agent` map",
      { agent: { build: { prompt: "p" } } },
      "data must NOT have additional properties",
    ],
    [
      "v1 `plugin` array",
      { plugin: ["opencode-plugin-a"] },
      "data must NOT have additional properties",
    ],
    [
      "v1 `npm` inside a v2 provider entry",
      { providers: { x: { npm: "@ai-sdk/anthropic" } } },
      "data/providers/x must NOT have additional properties",
    ],
    ["a non-string model", { model: 123 }, "data/model must be string"],
    [
      "a permission rule with an unknown effect",
      { permissions: [{ action: "*", resource: "*", effect: "maybe" }] },
      "data/permissions/0/effect must be equal to one of the allowed values",
    ],
  ])("%s", (_label, document, expectedError) => {
    const result = validate(document);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(expectedError);
  });
});
