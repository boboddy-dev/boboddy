import { describe, expect, test } from "bun:test";
import type { DiscoveredTool } from "../src/types";
import { createMcpHttpServer } from "../src/mcp-server";

function makeTool(name: string, execute?: (args: Record<string, unknown>) => Promise<string>): DiscoveredTool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    execute: execute ?? (async (args) => `echo:${String(args["input"] ?? "")}`),
  };
}

async function callMcp(
  server: ReturnType<typeof createMcpHttpServer>,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`http://localhost:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

describe("MCP HTTP server", () => {
  test("GET /health returns status ok", async () => {
    const tools = new Map<string, DiscoveredTool>();
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await fetch(`http://localhost:${server.port}/health`);
      const body = await response.json() as { status: string };
      expect(body.status).toBe("ok");
    } finally {
      server.stop(true);
    }
  });

  test("initialize returns server info", async () => {
    const tools = new Map<string, DiscoveredTool>();
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await callMcp(server, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }) as { result: { serverInfo: { name: string } } };
      expect(response.result.serverInfo.name).toBe("boboddy-mcp-host");
    } finally {
      server.stop(true);
    }
  });

  test("tools/list returns registered tools", async () => {
    const tool = makeTool("my-plugin_my-tool");
    const tools = new Map([[tool.name, tool]]);
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await callMcp(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }) as { result: { tools: Array<{ name: string }> } };
      expect(response.result.tools).toHaveLength(1);
      expect(response.result.tools[0]?.name).toBe("my-plugin_my-tool");
    } finally {
      server.stop(true);
    }
  });

  test("tools/call happy path returns tool output", async () => {
    const tool = makeTool("echo-tool", async (args) => `result:${String(args["input"])}`);
    const tools = new Map([[tool.name, tool]]);
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await callMcp(server, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo-tool", arguments: { input: "hello" } },
      }) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
      expect(response.result.isError).toBe(false);
      expect(response.result.content[0]?.text).toBe("result:hello");
    } finally {
      server.stop(true);
    }
  });

  test("tools/call unknown tool returns isError:true", async () => {
    const tools = new Map<string, DiscoveredTool>();
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await callMcp(server, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "nonexistent", arguments: {} },
      }) as { error: { code: number } };
      expect(response.error.code).toBe(-32601);
    } finally {
      server.stop(true);
    }
  });

  test("tools/call throwing tool returns isError:true with error message", async () => {
    const tool = makeTool("bad-tool", async () => {
      throw new Error("Something went wrong");
    });
    const tools = new Map([[tool.name, tool]]);
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await callMcp(server, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "bad-tool", arguments: { input: "x" } },
      }) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0]?.text).toContain("Something went wrong");
    } finally {
      server.stop(true);
    }
  });

  test("tools/list returns empty array when no tools loaded", async () => {
    const tools = new Map<string, DiscoveredTool>();
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await callMcp(server, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
      }) as { result: { tools: unknown[] } };
      expect(response.result.tools).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("unknown method returns method-not-found error", async () => {
    const tools = new Map<string, DiscoveredTool>();
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await callMcp(server, {
        jsonrpc: "2.0",
        id: 7,
        method: "doesNotExist",
      }) as { error: { code: number } };
      expect(response.error.code).toBe(-32601);
    } finally {
      server.stop(true);
    }
  });

  test("404 for unknown path", async () => {
    const tools = new Map<string, DiscoveredTool>();
    const server = createMcpHttpServer({ tools, warnings: [] }, 0);
    try {
      const response = await fetch(`http://localhost:${server.port}/unknown`);
      expect(response.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
