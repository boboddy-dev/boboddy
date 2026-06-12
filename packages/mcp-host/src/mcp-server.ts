import type { DiscoveredTool } from "./types";

/**
 * JSON-RPC 2.0 types used by MCP.
 */
type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * MCP error codes.
 */
const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TOOL_EXECUTION_ERROR: -32001,
} as const;

type McpServerState = {
  tools: Map<string, DiscoveredTool>;
  warnings: Array<{ pluginName: string; droppedHooks: string[] }>;
};

function makeError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function makeResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

/**
 * Handle a single MCP JSON-RPC request.
 */
async function handleRequest(
  state: McpServerState,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = request;

  switch (method) {
    case "initialize": {
      return makeResult(id ?? null, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "boboddy-mcp-host", version: "1.0.0" },
      });
    }

    case "notifications/initialized":
    case "initialized": {
      // Notification — no response needed
      return null;
    }

    case "tools/list": {
      const toolList = [...state.tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return makeResult(id ?? null, { tools: toolList });
    }

    case "tools/call": {
      const callParams = params as
        | { name?: unknown; arguments?: unknown }
        | undefined;
      const toolName = callParams?.name;
      const toolArgs = (callParams?.arguments ?? {}) as Record<string, unknown>;

      if (typeof toolName !== "string") {
        return makeError(id ?? null, MCP_ERROR_CODES.INVALID_PARAMS, "Missing tool name");
      }

      const tool = state.tools.get(toolName);
      if (!tool) {
        return makeError(
          id ?? null,
          MCP_ERROR_CODES.METHOD_NOT_FOUND,
          `Unknown tool: ${toolName}`,
        );
      }

      try {
        const output = await tool.execute(toolArgs);
        return makeResult(id ?? null, {
          content: [{ type: "text", text: output }],
          isError: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return makeResult(id ?? null, {
          content: [{ type: "text", text: `Tool error: ${message}` }],
          isError: true,
        });
      }
    }

    case "ping": {
      return makeResult(id ?? null, {});
    }

    default: {
      if (id === undefined || id === null) {
        // Notification — ignore unknown notifications silently
        return null;
      }
      return makeError(
        id,
        MCP_ERROR_CODES.METHOD_NOT_FOUND,
        `Method not found: ${method}`,
      );
    }
  }
}

/**
 * Parse a raw request body and return a JsonRpcRequest, or null on parse error.
 */
function parseRequest(body: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("method" in parsed) ||
      typeof (parsed as { method: unknown }).method !== "string"
    ) {
      return null;
    }
    return parsed as JsonRpcRequest;
  } catch {
    return null;
  }
}

/**
 * Build and return a Bun HTTP server for the MCP host.
 *
 * Serves:
 * - POST /mcp — MCP JSON-RPC endpoint (HTTP transport per MCP spec)
 * - GET /health — liveness probe
 */
export function createMcpHttpServer(
  state: McpServerState,
  port: number,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "0.0.0.0",
    port,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/health" && request.method === "GET") {
        return new Response(
          JSON.stringify({ status: "ok", tools: state.tools.size }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.pathname === "/mcp" && request.method === "POST") {
        let body: string;
        try {
          body = await request.text();
        } catch {
          return new Response(
            JSON.stringify(
              makeError(null, MCP_ERROR_CODES.PARSE_ERROR, "Failed to read request body"),
            ),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const rpcRequest = parseRequest(body);
        if (!rpcRequest) {
          return new Response(
            JSON.stringify(
              makeError(null, MCP_ERROR_CODES.PARSE_ERROR, "Invalid JSON-RPC request"),
            ),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const response = await handleRequest(state, rpcRequest);
        if (response === null) {
          // Notification — respond with 204 No Content
          return new Response(null, { status: 204 });
        }

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

export type { McpServerState };
