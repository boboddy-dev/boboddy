import type { Event, Message, Part, ToolState } from "@opencode-ai/sdk";

/**
 * Producer-side projection of an OpenCode agent conversation. This MUST stay
 * structurally compatible with `conversationEventSchema` in
 * `@boboddy/core/.../step-execution-log-contracts` — the worker does not depend
 * on core, so the contract is enforced by Zod on the consuming (platform/UI)
 * side. Each event is JSON-encoded into one `conversation`-stream log line.
 *
 * Parts carry a stable `partId`; OpenCode resends the full part on every update
 * so the consumer upserts by `partId` to render live streaming text and
 * tool-status transitions.
 */
export type ConversationRole = "user" | "assistant";

export type ConversationToolStatus =
  | "pending"
  | "running"
  | "completed"
  | "error";

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

const messageRole = (message: Message): ConversationRole =>
  message.role === "user" ? "user" : "assistant";

const toolStatusFields = (
  state: ToolState,
): {
  status: ConversationToolStatus;
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
} => {
  switch (state.status) {
    case "pending":
      return { status: "pending", input: clampToolInput(state.input) };
    case "running":
      return {
        status: "running",
        title: state.title,
        input: clampToolInput(state.input),
      };
    case "completed":
      return {
        status: "completed",
        title: state.title,
        input: clampToolInput(state.input),
        output: truncate(state.output, MAX_TOOL_OUTPUT_CHARS),
      };
    case "error":
      return {
        status: "error",
        input: clampToolInput(state.input),
        error: truncate(state.error, MAX_TOOL_OUTPUT_CHARS),
      };
  }
};

/**
 * Map an OpenCode message-part into a conversation event. Returns `undefined`
 * for part kinds we don't surface (step-start, file, etc.) so the streamer can
 * skip them. `role` is required for text parts because the UI bubbles text by
 * author and the part itself doesn't carry the role.
 */
export const partToConversationEvent = (
  part: Part,
  role: ConversationRole,
): ConversationEvent | undefined => {
  switch (part.type) {
    case "text":
      if (!part.text) return undefined;
      return {
        kind: "text",
        messageId: part.messageID,
        partId: part.id,
        role,
        text: part.text,
      };
    case "reasoning":
      if (!part.text) return undefined;
      return {
        kind: "reasoning",
        messageId: part.messageID,
        partId: part.id,
        text: part.text,
      };
    case "tool":
      return {
        kind: "tool",
        messageId: part.messageID,
        partId: part.id,
        callId: part.callID,
        tool: part.tool,
        ...toolStatusFields(part.state),
      };
    case "step-finish":
      return {
        kind: "step-finish",
        messageId: part.messageID,
        cost: part.cost,
        tokens: {
          input: part.tokens.input,
          output: part.tokens.output,
          reasoning: part.tokens.reasoning,
        },
      };
    default:
      return undefined;
  }
};

/** Map an OpenCode `message.updated` info payload into a message event. */
export const messageToConversationEvent = (
  message: Message,
): Extract<ConversationEvent, { kind: "message" }> => ({
  kind: "message",
  id: message.id,
  role: messageRole(message),
  modelID: message.role === "assistant" ? message.modelID : undefined,
  createdMs: message.time.created,
});

/**
 * Extract a human-readable error message from a `session.error` event payload.
 * The SDK error union nests the message under `data.message` for most variants.
 */
export const sessionErrorEventToConversationEvent = (
  event: Extract<Event, { type: "session.error" }>,
): ConversationEvent | undefined => {
  const error = event.properties.error;
  if (!error) return undefined;
  const data = (error as { data?: { message?: unknown } }).data;
  const message =
    data && typeof data.message === "string" ? data.message : error.name;
  return { kind: "session-error", message };
};
