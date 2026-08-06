/**
 * A tiny, REAL (not mocked) stdio MCP server used only as an integration-test
 * fixture for `force-and-verify-mcp-canary.integration.test.ts`.
 *
 * It speaks the actual MCP protocol over stdio via the official SDK — there is
 * no in-process faking here, unlike `FakeAiServer` (which fakes the AI
 * provider, not the MCP server). This is spawned as a real child process by a
 * real OpenCode agent, exactly like a real MCP server (e.g. Playwright's)
 * would be.
 *
 * Two tools:
 *   - `echo`  — always succeeds, echoing back its `text` argument.
 *   - `boom`  — always throws, so the SDK returns a JSON-RPC error response.
 *     This is the "genuinely broken" tool call the canary is meant to catch —
 *     the MCP handshake completes fine, but the tool call itself fails.
 *
 * Run directly: `bun run fixture-mcp-server.ts`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const FIXTURE_ECHO_TOOL = "echo";
export const FIXTURE_BOOM_TOOL = "boom";

// Deliberately the low-level `Server`, not the recommended high-level
// `McpServer`. `McpServer.registerTool` catches a thrown handler error and
// converts it into a spec-compliant `{isError: true}` *result* (still a
// successful JSON-RPC response) — but OpenCode's own MCP tool adapter
// (`mcp/catalog.ts` in the opencode repo) never inspects `CallToolResult
// .isError`; it only maps a `ToolPart` to `status: "error"` when the
// underlying `client.callTool()` call itself throws, i.e. a genuine
// protocol-level (JSON-RPC) error. `Server` lets a thrown handler error
// propagate as exactly that, which is what this fixture needs to reproduce
// the "genuinely broken tool call" failure mode the ticket describes.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const server = new Server(
  { name: "boboddy-fixture-mcp-server", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: FIXTURE_ECHO_TOOL,
      description: "Always succeeds; echoes back the `text` argument.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: FIXTURE_BOOM_TOOL,
      description: "Always throws, to simulate a genuinely broken tool call.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: args } = request.params;

  if (name === FIXTURE_ECHO_TOOL) {
    const text = typeof args?.["text"] === "string" ? args["text"] : "";
    return { content: [{ type: "text", text: `echo: ${text}` }] };
  }

  if (name === FIXTURE_BOOM_TOOL) {
    // Thrown (not `{isError: true}`) so the SDK's request dispatcher turns
    // this into a JSON-RPC error response — the failure mode a real broken
    // tool (e.g. Playwright without a launched browser) actually produces.
    throw new Error("boom: intentionally broken fixture tool");
  }

  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
