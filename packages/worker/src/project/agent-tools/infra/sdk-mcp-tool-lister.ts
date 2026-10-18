import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AnyJsonObject } from "../../../common/contracts/json";
import type { McpToolLister } from "../application/list-mcp-server-tools";
import type { ListedMcpTool } from "../domain/agent-tools-manifest";
import type { DiscoveredMcpServer } from "../domain/discovered-agent-tools";

/**
 * {@link McpToolLister} over the official MCP SDK client.
 *
 * A `local` server is spawned with the merged env plus its own `environment`,
 * in its `cwd` resolved against `repoRoot` (default `repoRoot`), stderr
 * discarded. A `remote` server is tried over Streamable HTTP first and SSE
 * second, as OpenCode does. Every `{env:VAR}` is substituted from the merged
 * env before starting. The client is always closed, which for stdio
 * terminates the process (SIGTERM, then SIGKILL), on success, failure and
 * abort alike.
 */
export class SdkMcpToolLister implements McpToolLister {
  constructor(private readonly options: { repoRoot: string }) {}

  async listTools(input: {
    server: DiscoveredMcpServer;
    env: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }): Promise<ListedMcpTool[]> {
    const { config } = input.server;
    const resolve = (value: string) => substituteEnv(value, input.env);

    if (config.type === "local") {
      const [command = "", ...args] = config.command.map(resolve);
      const environment = Object.fromEntries(
        Object.entries(config.environment ?? {}).map(([key, value]) => [
          key,
          resolve(value),
        ]),
      );
      return listOver(
        new StdioClientTransport({
          command,
          args,
          env: { ...input.env, ...environment },
          cwd: path.resolve(
            this.options.repoRoot,
            config.cwd === undefined ? "." : resolve(config.cwd),
          ),
          stderr: "ignore",
        }),
        input.signal,
      );
    }

    const url = new URL(resolve(config.url));
    const headers = Object.fromEntries(
      Object.entries(config.headers ?? {}).map(([key, value]) => [
        key,
        resolve(value),
      ]),
    );
    try {
      return await listOver(
        new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
        input.signal,
      );
    } catch (streamableError) {
      if (input.signal.aborted) throw streamableError;
      try {
        return await listOver(
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- the SSE fallback OpenCode also keeps for older servers
          new SSEClientTransport(url, { requestInit: { headers } }),
          input.signal,
        );
      } catch {
        throw streamableError;
      }
    }
  }
}

const ENV_PLACEHOLDER = /\{env:([^}]+)\}/gu;

function substituteEnv(
  value: string,
  env: Readonly<Record<string, string>>,
): string {
  return value.replace(ENV_PLACEHOLDER, (_, name: string) => env[name] ?? "");
}

async function listOver(
  transport: Transport,
  signal: AbortSignal,
): Promise<ListedMcpTool[]> {
  const client = new Client({
    name: "boboddy-designer-preflight",
    version: "0",
  });
  const close = () => {
    void client.close().catch(() => undefined);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(transport, { signal });
    const tools: ListedMcpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal },
      );
      tools.push(...page.tools.map(toListedTool));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  } finally {
    signal.removeEventListener("abort", close);
    await client.close().catch(() => undefined);
  }
}

function toListedTool(tool: Tool): ListedMcpTool {
  const readOnlyHint = tool.annotations?.readOnlyHint;
  return {
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as AnyJsonObject,
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
  };
}
