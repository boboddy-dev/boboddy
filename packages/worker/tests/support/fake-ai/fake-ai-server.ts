/**
 * Minimal Anthropic-compatible HTTP server used across the Boboddy test suites
 * (worker integration tests and the CLI-to-server e2e tests).
 *
 * This is the SINGLE source of truth for the fake AI provider. The AI agent runs
 * inside the user's devcontainer (OpenCode); OpenCode's Anthropic provider
 * `baseURL` is pointed at this server via a seeded opencode config (see
 * {@link seedOpencodeConfig}) so tests never call a real AI provider.
 *
 * On each `POST /messages` or `/v1/messages`:
 *   - If the conversation already contains a `tool_result` block, returns an
 *     `end_turn` text response so OpenCode closes the session.
 *   - Otherwise, returns a streaming `tool_use` call for
 *     `boboddy-submit-step-findings` with the configured `findingsJson`.
 *
 * Point OpenCode at this server with:
 *   provider.anthropic.options.baseURL = http://host.docker.internal:<port>
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

type AnthropicTool = { name: string };

type AnthropicRequest = {
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
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

function findSubmitFindingsToolName(
  tools: AnthropicTool[] | undefined,
): string {
  return (
    tools?.find((t) => t.name.includes("submit"))?.name ??
    "boboddy-submit-step-findings"
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
  toolInput: unknown,
  findingsText: string,
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
      delta: { type: "text_delta", text: findingsText },
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
        partial_json: JSON.stringify(toolInput),
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
  toolInput: unknown,
  findingsText: string,
): string {
  return JSON.stringify({
    id: `msg_${uid()}`,
    type: "message",
    role: "assistant",
    model: "claude-3-5-haiku-latest",
    content: [
      { type: "text", text: findingsText },
      {
        type: "tool_use",
        id: `toolu_${uid()}`,
        name: toolName,
        input: toolInput,
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
  private findings: unknown = {};
  private messageRequestCount = 0;
  private readonly verbose: boolean;
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });

  constructor(options: FakeAiServerOptions = {}) {
    this.verbose = options.verbose ?? false;
  }

  /**
   * Sets the `findingsJson` payload the fake agent will submit via the
   * boboddy-submit-step-findings tool on its first turn.
   */
  // eslint-disable-next-line local/no-unknown-parameter-type
  configure(findings: unknown): this {
    this.findings = findings;
    return this;
  }

  /** Number of /messages requests received — useful for assertions. */
  get requestCount(): number {
    return this.messageRequestCount;
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(message);
    }
  }

  private logRequest(url: string, method: string, parsed: AnthropicRequest): void {
    if (!this.verbose) {
      return;
    }

    const toolName = findSubmitFindingsToolName(parsed.tools);
    const lastMessage = parsed.messages.at(-1);

    this.log(
      `[fake-ai-server] ${method} ${url} stream=${String(
        parsed.stream !== false,
      )} messages=${String(parsed.messages.length)} toolCount=${String(
        parsed.tools?.length ?? 0,
      )} hasToolResult=${String(hasToolResult(parsed.messages))} selectedTool=${toolName}`,
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
      const toolName = findSubmitFindingsToolName(parsed.tools);

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
          // the mounted workspace before the findings tool tries to read it.
          await delay(INITIAL_TOOL_USE_DELAY_MS);
          res.end(
            buildToolUseStream(
              toolName,
              { findingsJson: this.findings },
              `this.findings = ${JSON.stringify(this.findings, null, 2)}`,
            ),
          );
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      if (hasToolResult(parsed.messages)) {
        res.end(buildEndTurnResponse());
      } else {
        await delay(INITIAL_TOOL_USE_DELAY_MS);
        res.end(
          buildToolUseResponse(
            toolName,
            { findingsJson: this.findings },
            `this.findings = ${JSON.stringify(this.findings, null, 2)}`,
          ),
        );
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
        resolve((this.server.address() as AddressInfo).port);
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
