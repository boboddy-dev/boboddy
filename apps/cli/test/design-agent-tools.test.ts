import { describe, expect, test } from "bun:test";
import type {
  AgentToolsManifest,
  DiscoveredAgentTools,
  DiscoveredMcpServer,
} from "@boboddy/worker";
import {
  announceMcpToolListing,
  ensureAgentToolsManifest,
} from "../src/lib/design-agent-tools";
import {
  EMPTY_DISCOVERY,
  FAKE_AGENT_TOOLS_MANIFEST_PATH,
  fakeAgentToolsPorts,
} from "./design-agent-tools-fakes";
import { createReporterRecorder } from "./utils";

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

const DISCOVERY: DiscoveredAgentTools = {
  ...EMPTY_DISCOVERY,
  servers: [server("postgres"), server("sentry", ["SENTRY_TOKEN"])],
  skills: [
    {
      name: "triage",
      description: "Triage a ticket",
      path: ".claude/skills/triage/SKILL.md",
      shadowed: [],
    },
  ],
};

async function run(
  overrides: Parameters<typeof fakeAgentToolsPorts>[0] = {},
): Promise<{
  result: string | null;
  written: AgentToolsManifest[];
  recorder: ReturnType<typeof createReporterRecorder>;
}> {
  const written: AgentToolsManifest[] = [];
  const recorder = createReporterRecorder();
  const result = await ensureAgentToolsManifest({
    project: "acme/app",
    owner: "acme",
    slug: "app",
    reporter: recorder.reporter,
    now: () => new Date("2026-10-14T00:00:00Z"),
    ports: fakeAgentToolsPorts({
      writeAgentToolsManifest: ({ manifest }) => {
        written.push(manifest);
        return Promise.resolve(FAKE_AGENT_TOOLS_MANIFEST_PATH);
      },
      ...overrides,
    }),
  });
  return { result, written, recorder };
}

describe("announceMcpToolListing", () => {
  test("is count-accurate", () => {
    expect(announceMcpToolListing(1)).toBe(
      "Starting 1 MCP server from your repo to list its tools…",
    );
    expect(announceMcpToolListing(4)).toBe(
      "Starting 4 MCP servers from your repo to list their tools…",
    );
  });
});

describe("ensureAgentToolsManifest", () => {
  test("announces only the servers it will start, and records the rest as unavailable", async () => {
    const { result, written, recorder } = await run({
      discoverAgentTools: () => Promise.resolve(DISCOVERY),
      mcpToolLister: {
        listTools: () =>
          Promise.resolve([{ name: "query", inputSchema: { type: "object" } }]),
      },
    });

    expect(result).toBe(FAKE_AGENT_TOOLS_MANIFEST_PATH);
    expect(recorder.tasks[0]).toEqual({
      method: "startActivity",
      message: "Starting 1 MCP server from your repo to list its tools…",
    });
    const [manifest] = written;
    expect(manifest?.servers.map((s) => [s.name, s.availability])).toEqual([
      ["postgres", { status: "available" }],
      ["sentry", { status: "unavailable", reason: "missing SENTRY_TOKEN" }],
    ]);
    expect(manifest?.skills).toEqual([
      {
        name: "triage",
        description: "Triage a ticket",
        path: ".claude/skills/triage/SKILL.md",
      },
    ]);
  });

  test("starts nothing and announces nothing when the repo defines no servers", async () => {
    const { result, recorder } = await run();

    expect(result).toBe(FAKE_AGENT_TOOLS_MANIFEST_PATH);
    expect(recorder.tasks).toEqual([]);
  });

  test("never writes an env value into the manifest", async () => {
    const { written } = await run({
      discoverAgentTools: () =>
        Promise.resolve({
          ...EMPTY_DISCOVERY,
          servers: [server("sentry", ["SENTRY_TOKEN"])],
        }),
      readToolEnv: () => Promise.resolve({ SENTRY_TOKEN: "sk-live-secret" }),
      mcpToolLister: {
        listTools: () =>
          Promise.reject(new Error("401 for token sk-live-secret")),
      },
    });

    expect(JSON.stringify(written)).not.toContain("sk-live-secret");
    expect(written[0]?.servers[0]?.availability).toEqual({
      status: "failed",
      reason: "401 for token {env:SENTRY_TOKEN}",
    });
  });

  test("a failure is reported, never fatal", async () => {
    const { result, recorder } = await run({
      discoverAgentTools: () => Promise.reject(new Error("disk on fire")),
    });

    expect(result).toBeNull();
    expect(recorder.calls).toContainEqual({
      method: "warn",
      message:
        "Could not record this repository's MCP servers and skills for the designer: disk on fire",
    });
  });
});
