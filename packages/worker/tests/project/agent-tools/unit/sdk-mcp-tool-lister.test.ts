import { describe, expect, test } from "bun:test";
import path from "node:path";
import { SdkMcpToolLister } from "../../../../src/project/agent-tools/infra/sdk-mcp-tool-lister";
import type { DiscoveredMcpServer } from "../../../../src/project/agent-tools/domain/discovered-agent-tools";

/**
 * One real stdio round trip against the SDK fixture server: cheap (a bun
 * child process, no network) and the only check that the lister speaks the
 * protocol rather than a fake of it.
 */

const FIXTURE_SERVER_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "work",
  "task",
  "integration",
  "helpers",
  "mcp",
  "fixture-mcp-server.ts",
);

function fixtureServer(command: string[]): DiscoveredMcpServer {
  return {
    name: "fixture",
    source: ".mcp.json",
    transport: "local",
    config: { type: "local", command },
    requiredEnv: [],
    inlineSecrets: [],
    shadowed: [],
  };
}

describe("SdkMcpToolLister", () => {
  test("starts a stdio server, lists its tools, and stops it", async () => {
    const lister = new SdkMcpToolLister({ repoRoot: import.meta.dirname });

    const tools = await lister.listTools({
      server: fixtureServer([process.execPath, "run", FIXTURE_SERVER_PATH]),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      signal: AbortSignal.timeout(15_000),
    });

    expect(tools.map((tool) => tool.name)).toEqual(["echo", "boom"]);
    expect(tools[0]).toEqual({
      name: "echo",
      description: "Always succeeds; echoes back the `text` argument.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    });
  });

  test("rejects when the command does not exist", async () => {
    const lister = new SdkMcpToolLister({ repoRoot: import.meta.dirname });

    let rejected = false;
    try {
      await lister.listTools({
        server: fixtureServer(["boboddy-no-such-mcp-server-binary"]),
        env: {},
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
