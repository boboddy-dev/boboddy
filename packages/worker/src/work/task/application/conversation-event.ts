import type {
  SessionStructuredError,
  TokenUsageInfo,
  ToolContent1,
  V2Event,
} from "@opencode/client";

/**
 * Producer-side projection of an OpenCode agent conversation. This MUST stay
 * structurally compatible with `conversationEventSchema` in
 * `@boboddy/core/.../task-log-contracts` — the worker does not depend
 * on core, so the contract is enforced by Zod on the consuming (platform/UI)
 * side. Each event is JSON-encoded into one `conversation`-stream log line.
 *
 * Parts carry a stable `partId` and every emitted part is a full snapshot, so
 * the consumer upserts by `partId` to render live streaming text and
 * tool-status transitions.
 */
export type ConversationRole = "user" | "assistant";

export type ConversationToolStatus =
  "pending" | "running" | "completed" | "error";

export type ConversationEvent =
  | {
      kind: "message";
      id: string;
      role: ConversationRole;
      modelID?: string;
      createdMs: number;
    }
  | {
      kind: "text";
      messageId: string;
      partId: string;
      role: ConversationRole;
      text: string;
    }
  | {
      kind: "reasoning";
      messageId: string;
      partId: string;
      text: string;
    }
  | {
      kind: "tool";
      messageId: string;
      partId: string;
      callId: string;
      tool: string;
      status: ConversationToolStatus;
      title?: string;
      input?: unknown;
      output?: string;
      error?: string;
    }
  | {
      kind: "step-finish";
      messageId: string;
      cost: number;
      tokens: { input: number; output: number; reasoning: number };
    }
  | {
      kind: "session-error";
      message: string;
    };

/**
 * One projected event. `streaming` marks a text/reasoning snapshot that is
 * still growing, which the streamer debounces per `partId` instead of
 * shipping every token.
 */
export type ProjectedConversationEvent = {
  event: ConversationEvent;
  streaming: boolean;
};

/**
 * Tool input/output can be large (full file contents, command output). Cap them
 * before shipping so a single tool call can't blow past the per-line content
 * limit enforced by the shipper/server.
 */
const MAX_TOOL_OUTPUT_CHARS = 8_000;
const MAX_TOOL_INPUT_CHARS = 4_000;

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}… [truncated]` : value;

const clampToolInput = (input: Record<string, unknown>): unknown => {
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length <= MAX_TOOL_INPUT_CHARS) {
      return input;
    }
    return { _truncated: truncate(serialized, MAX_TOOL_INPUT_CHARS) };
  } catch {
    return { _unserializable: true };
  }
};

/** Joins a v2 tool result's text items; file items render as their name/uri. */
export const renderToolContent = (
  content: readonly ToolContent1[] | undefined,
): string =>
  (content ?? [])
    .map((item) => (item.type === "text" ? item.text : (item.name ?? item.uri)))
    .join("\n");

/** `type: message`, the one-line form of a v2 structured error. */
export const formatStructuredError = (error: SessionStructuredError): string =>
  `${error.type}: ${error.message}`;

const stepTokens = (
  tokens: TokenUsageInfo,
): { input: number; output: number; reasoning: number } => ({
  input: tokens.input,
  output: tokens.output,
  reasoning: tokens.reasoning,
});

/** v2 streams text/reasoning by ordinal within an assistant message. */
const contentPartId = (assistantMessageID: string, ordinal: number): string =>
  `${assistantMessageID}:${String(ordinal)}`;

type ToolCallState = {
  messageId: string;
  tool: string;
  input?: unknown;
};

/**
 * Folds the v2 OpenCode event stream for one session into
 * {@link ConversationEvent}s. Stateful because v2 events are incremental:
 * text arrives as deltas (accumulated here into full snapshots), and a tool
 * call's name and input arrive on earlier events than its result.
 *
 * Events for other sessions, and event kinds Boboddy does not surface, project
 * to nothing.
 */
export class ConversationEventProjector {
  private readonly textByPartId = new Map<string, string>();
  private readonly toolCalls = new Map<string, ToolCallState>();
  private lastSessionError: string | undefined;

  constructor(private readonly sessionId: string) {}

  project(event: V2Event): ProjectedConversationEvent[] {
    if (!("data" in event) || !isSessionScoped(event.data, this.sessionId)) {
      return [];
    }

    switch (event.type) {
      case "session.inbox.enqueued": {
        if (event.data.item.type !== "user") return [];
        const messageId = event.data.inboxID;
        const text = event.data.item.payload.text;
        return [
          settled({
            kind: "message",
            id: messageId,
            role: "user",
            createdMs: event.created,
          }),
          ...(text
            ? [
                settled({
                  kind: "text",
                  messageId,
                  partId: contentPartId(messageId, 0),
                  role: "user",
                  text,
                }),
              ]
            : []),
        ];
      }
      case "session.step.started":
        return [
          settled({
            kind: "message",
            id: event.data.assistantMessageID,
            role: "assistant",
            modelID: event.data.model.id,
            createdMs: event.data.started,
          }),
        ];
      case "session.text.delta":
      case "session.reasoning.delta": {
        const partId = contentPartId(
          event.data.assistantMessageID,
          event.data.ordinal,
        );
        const text = (this.textByPartId.get(partId) ?? "") + event.data.delta;
        this.textByPartId.set(partId, text);
        return this.contentEvent(event, partId, text, true);
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const partId = contentPartId(
          event.data.assistantMessageID,
          event.data.ordinal,
        );
        this.textByPartId.delete(partId);
        return this.contentEvent(event, partId, event.data.text, false);
      }
      case "session.tool.input.started": {
        const call: ToolCallState = {
          messageId: event.data.assistantMessageID,
          tool: event.data.name,
        };
        this.toolCalls.set(event.data.id, call);
        return [this.toolEvent(event.data.id, call, { status: "pending" })];
      }
      case "session.tool.called": {
        const call = this.toolCall(
          event.data.id,
          event.data.assistantMessageID,
        );
        call.input = clampToolInput(event.data.input);
        return [
          this.toolEvent(event.data.id, call, {
            status: "running",
            input: call.input,
          }),
        ];
      }
      case "session.tool.success": {
        const call = this.toolCall(
          event.data.id,
          event.data.assistantMessageID,
        );
        this.toolCalls.delete(event.data.id);
        return [
          this.toolEvent(event.data.id, call, {
            status: "completed",
            input: call.input,
            output: truncate(
              renderToolContent(event.data.content),
              MAX_TOOL_OUTPUT_CHARS,
            ),
          }),
        ];
      }
      case "session.tool.failed": {
        const call = this.toolCall(
          event.data.id,
          event.data.assistantMessageID,
        );
        this.toolCalls.delete(event.data.id);
        return [
          this.toolEvent(event.data.id, call, {
            status: "error",
            input: call.input,
            error: truncate(
              formatStructuredError(event.data.error),
              MAX_TOOL_OUTPUT_CHARS,
            ),
          }),
        ];
      }
      case "session.step.ended":
        return [
          settled({
            kind: "step-finish",
            messageId: event.data.assistantMessageID,
            cost: event.data.cost,
            tokens: stepTokens(event.data.tokens),
          }),
        ];
      case "session.step.failed":
      case "session.execution.failed":
        return this.sessionError(event.data.error);
      default:
        return [];
    }
  }

  private contentEvent(
    event: { type: string; data: { assistantMessageID: string } },
    partId: string,
    text: string,
    streaming: boolean,
  ): ProjectedConversationEvent[] {
    if (!text) return [];
    const messageId = event.data.assistantMessageID;
    const conversationEvent: ConversationEvent = event.type.startsWith(
      "session.reasoning.",
    )
      ? { kind: "reasoning", messageId, partId, text }
      : { kind: "text", messageId, partId, role: "assistant", text };
    return [{ event: conversationEvent, streaming }];
  }

  private toolCall(callId: string, messageId: string): ToolCallState {
    const existing = this.toolCalls.get(callId);
    if (existing) return existing;
    const created: ToolCallState = { messageId, tool: "unknown" };
    this.toolCalls.set(callId, created);
    return created;
  }

  private toolEvent(
    callId: string,
    call: ToolCallState,
    fields: {
      status: ConversationToolStatus;
      input?: unknown;
      output?: string;
      error?: string;
    },
  ): ProjectedConversationEvent {
    return settled({
      kind: "tool",
      messageId: call.messageId,
      partId: callId,
      callId,
      tool: call.tool,
      ...fields,
    });
  }

  /**
   * A failed step is usually followed by a failed execution carrying the same
   * error; ship it once. A deliberate interrupt (`aborted`) is not an error.
   */
  private sessionError(
    error: SessionStructuredError,
  ): ProjectedConversationEvent[] {
    if (error.type === "aborted") return [];
    const message = formatStructuredError(error);
    if (message === this.lastSessionError) return [];
    this.lastSessionError = message;
    return [settled({ kind: "session-error", message })];
  }
}

const settled = (event: ConversationEvent): ProjectedConversationEvent => ({
  event,
  streaming: false,
});

function isSessionScoped(data: object, sessionId: string): boolean {
  return (data as { sessionID?: unknown }).sessionID === sessionId;
}
