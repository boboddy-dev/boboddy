/**
 * Minimal Anthropic-compatible HTTP server used to force an OpenCode provider
 * backed by `@ai-sdk/anthropic` (pointed at it via `baseURL`) to make a
 * single, scripted `tool_use` call, then close the turn once it sees the
 * matching `tool_result`.
 *
 * This is the SINGLE source of truth for the fake AI provider. It is used both
 * by the worker/e2e test suites (which never call a real AI provider) and by
 * the dry-run "canary" feature, which forces an arbitrary MCP tool call
 * through a real OpenCode session to verify it actually works.
 *
 * The tool forced on the first turn — and the exact arguments it is called
 * with — are explicit parameters passed to {@link FakeAiServer.configure};
 * this server never infers the tool from the request's `tools` array.
 *
 * On each `POST /messages` or `/v1/messages`:
 *   - If the conversation already contains a `tool_result` block, returns an
 *     `end_turn` text response so OpenCode closes the session.
 *   - Otherwise, returns a streaming `tool_use` call for the configured tool
 *     name and arguments.
 *
 * Point OpenCode at this server with, for provider id `<id>`:
 *   provider.<id>.npm = "@ai-sdk/anthropic"
 *   provider.<id>.options.baseURL = http://host.docker.internal:<port>
 * (`npm` is implicit only when `<id>` is a real registry id such as
 * `anthropic`; see `fake-provider-config.ts`.)
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

type MessageContentBlock = { type: string };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | MessageContentBlock[];
};

type AnthropicRequest = {
  messages: AnthropicMessage[];
  tools?: { name: string }[];
  stream?: boolean;
};

type MessageContentWithToolResult = MessageContentBlock & {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export type FakeAiServerOptions = {
  /**
   * When true, logs each received request (endpoint, tool list, last message)
   * to the console with a `[fake-ai-server]` prefix. Useful when debugging why
   * a session never progressed. Defaults to false.
   */
  verbose?: boolean;
};

/**
 * The tool name to force on the first turn, and the exact arguments to call it
 * with. Set via {@link FakeAiServer.configure}.
 */
export type FakeAiForcedToolCall = {
  toolName: string;
  toolArgs: unknown;
};

const DEFAULT_FORCED_TOOL_CALL: FakeAiForcedToolCall = {
  toolName: "boboddy-submit-step-findings",
  toolArgs: {},
};

const INITIAL_TOOL_USE_DELAY_MS = 1000;

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeMessageContent(
  content: AnthropicMessage["content"],
): string[] | string {
  if (typeof content === "string") {
    return content.length > 120 ? `${content.slice(0, 120)}...` : content;
  }

  return content.map((block) => block.type);
}

function extractToolResultBlocks(
  content: AnthropicMessage["content"],
): MessageContentWithToolResult[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(
    (block): block is MessageContentWithToolResult =>
      block.type === "tool_result",
  );
}

function matchesAnthropicPath(
  url: string,
  endpoint: "messages" | "models",
): boolean {
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  return pathname === `/${endpoint}` || pathname === `/v1/${endpoint}`;
}

function hasToolResult(messages: AnthropicMessage[]): boolean {
  return messages.some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some((block) => block.type === "tool_result"),
  );
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// eslint-disable-next-line local/no-unknown-parameter-type
function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
}

function buildToolUseStream(
  toolName: string,
  // eslint-disable-next-line local/no-unknown-parameter-type
  toolArgs: unknown,
  announcementText: string,
): string {
  return [
    sseEvent("message_start", {
      message: {
        id: `msg_${uid()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-5-haiku-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
    sseEvent("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: announcementText },
    }),
    sseEvent("content_block_stop", { index: 0 }),
    sseEvent("content_block_start", {
      index: 1,
      content_block: {
        type: "tool_use",
        id: `toolu_${uid()}`,
        name: toolName,
        input: {},
      },
    }),
    sseEvent("content_block_delta", {
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(toolArgs),
      },
    }),
    sseEvent("content_block_stop", { index: 1 }),
    sseEvent("message_delta", {
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 50 },
    }),
    sseEvent("message_stop", {}),
  ].join("");
}

function buildEndTurnStream(): string {
  return [
    sseEvent("message_start", {
      message: {
        id: `msg_${uid()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-5-haiku-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 150,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
    sseEvent("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "Fake ai response." },
    }),
    sseEvent("content_block_stop", { index: 0 }),
    sseEvent("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sseEvent("message_stop", {}),
  ].join("");
}

function buildToolUseResponse(
  toolName: string,
  // eslint-disable-next-line local/no-unknown-parameter-type
  toolArgs: unknown,
  announcementText: string,
): string {
  return JSON.stringify({
    id: `msg_${uid()}`,
    type: "message",
    role: "assistant",
    model: "claude-3-5-haiku-latest",
    content: [
      { type: "text", text: announcementText },
      {
        type: "tool_use",
        id: `toolu_${uid()}`,
        name: toolName,
        input: toolArgs,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 50,
    },
  });
}

function buildEndTurnResponse(): string {
  return JSON.stringify({
    id: `msg_${uid()}`,
    type: "message",
    role: "assistant",
    model: "claude-3-5-haiku-latest",
    content: [{ type: "text", text: "Fake ai response." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 150,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 5,
    },
  });
}

function buildModelListResponse(): string {
  return JSON.stringify({
    data: [
      {
        id: "claude-3-5-haiku-latest",
        type: "model",
        display_name: "Claude 3.5 Haiku",
        created_at: "2024-10-22T00:00:00Z",
      },
    ],
    has_more: false,
  });
}

export class FakeAiServer {
  private forcedToolCall: FakeAiForcedToolCall = DEFAULT_FORCED_TOOL_CALL;
  private messageRequestCount = 0;
  private startedPort: number | undefined;
  private readonly verbose: boolean;
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });

  constructor(options: FakeAiServerOptions = {}) {
    this.verbose = options.verbose ?? false;
  }

  /**
   * Sets the tool name and arguments the fake agent will force a `tool_use`
   * call for on its first turn. Both are explicit — this server never infers
   * the tool from the request's `tools` array.
   */
  // eslint-disable-next-line local/no-unknown-parameter-type
  configure(toolName: string, toolArgs: unknown): this {
    this.forcedToolCall = { toolName, toolArgs };
    return this;
  }

  /** Number of /messages requests received — useful for assertions. */
  get requestCount(): number {
    return this.messageRequestCount;
  }

  /**
   * The port {@link start} bound to. Callers that need to point a live
   * OpenCode agent's `provider.*.options.baseURL` at this server (e.g. the MCP
   * canary feature) read this instead of threading the `start()` return value
   * through separately. Throws if read before `start()` resolves.
   */
  get port(): number {
    if (this.startedPort === undefined) {
      throw new Error("FakeAiServer.port was read before start() resolved");
    }
    return this.startedPort;
  }

  private log(message: string): void {
    if (this.verbose) {
      console.warn(message);
    }
  }

  private logRequest(url: string, method: string, parsed: AnthropicRequest): void {
    if (!this.verbose) {
      return;
    }

    const { toolName } = this.forcedToolCall;
    const lastMessage = parsed.messages.at(-1);

    this.log(
      `[fake-ai-server] ${method} ${url} stream=${String(
        parsed.stream !== false,
      )} messages=${String(parsed.messages.length)} toolCount=${String(
        parsed.tools?.length ?? 0,
      )} hasToolResult=${String(hasToolResult(parsed.messages))} forcedTool=${toolName}`,
    );
    if (parsed.tools?.length) {
      this.log(
        `[fake-ai-server] tools: ${parsed.tools
          .map((tool) => tool.name)
          .join(", ")}`,
      );
    }
    if (lastMessage) {
      this.log(
        `[fake-ai-server] last message role=${lastMessage.role} contentSummary=${JSON.stringify(
          summarizeMessageContent(lastMessage.content),
        )}`,
      );

      const toolResults = extractToolResultBlocks(lastMessage.content);
      if (toolResults.length > 0) {
        this.log(
          `[fake-ai-server] tool results: ${JSON.stringify(toolResults, null, 2)}`,
        );
      }
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "POST" && matchesAnthropicPath(url, "messages")) {
      this.messageRequestCount += 1;
      let parsed: AnthropicRequest;
      try {
        parsed = JSON.parse(body) as AnthropicRequest;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { type: "invalid_request_error", message: "invalid json" },
          }),
        );
        return;
      }

      this.logRequest(url, method, parsed);

      const hasStream = parsed.stream !== false;
      const { toolName, toolArgs } = this.forcedToolCall;
      const announcementText = `Forcing tool call: ${toolName}(${JSON.stringify(toolArgs)})`;

      if (hasStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (hasToolResult(parsed.messages)) {
          res.end(buildEndTurnStream());
        } else {
          // Give the runtime a moment to write .boboddy/current-execution into
          // the mounted workspace before the forced tool call reads it.
          await delay(INITIAL_TOOL_USE_DELAY_MS);
          res.end(buildToolUseStream(toolName, toolArgs, announcementText));
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      if (hasToolResult(parsed.messages)) {
        res.end(buildEndTurnResponse());
      } else {
        await delay(INITIAL_TOOL_USE_DELAY_MS);
        res.end(buildToolUseResponse(toolName, toolArgs, announcementText));
      }
      return;
    }

    if (method === "GET" && matchesAnthropicPath(url, "models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(buildModelListResponse());
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { type: "not_found_error", message: "not found" },
      }),
    );
  }

  /** Starts the server on an ephemeral port (bound to 0.0.0.0) and returns it. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, "0.0.0.0", () => {
        const port = (this.server.address() as AddressInfo).port;
        this.startedPort = port;
        resolve(port);
      });
      this.server.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
