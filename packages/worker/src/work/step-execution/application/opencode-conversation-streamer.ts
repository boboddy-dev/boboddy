import { createOpencodeClient, type Message, type Part } from "@opencode-ai/sdk";
import type { StepExecutionLogShipper } from "./step-execution-log-shipper";
import {
  messageToConversationEvent,
  partToConversationEvent,
  sessionErrorEventToConversationEvent,
  type ConversationEvent,
  type ConversationRole,
} from "./conversation-event";

/**
 * Subscribes to the in-container OpenCode event stream (SSE) and ships a
 * structured projection of the agent conversation into a
 * {@link StepExecutionLogShipper} as the `conversation` stream.
 *
 * Mirrors {@link OpencodeLogTail}'s lifecycle and best-effort contract: a failed
 * subscription is reported via `onError` and never throws, since conversation
 * capture must not break step execution. Only events for the monitored
 * `sessionId` are forwarded.
 *
 * Streaming text/reasoning parts arrive as a burst of `message.part.updated`
 * events (one per token chunk). To avoid shipping one log line per token, those
 * are debounced per `partId`: the latest full part snapshot is enqueued after a
 * short quiet window. Tool-state transitions ship immediately (few per call).
 */
const TEXT_PART_DEBOUNCE_MS = 250;

export class OpencodeConversationStreamer {
  private stopped = false;
  private abortController: AbortController | null = null;
  /** Roles by messageId, learned from `message.updated`, to label text parts. */
  private readonly rolesByMessageId = new Map<string, ConversationRole>();
  /** Pending debounced text/reasoning parts keyed by partId. */
  private readonly pendingParts = new Map<
    string,
    { event: ConversationEvent; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly deps: {
      agentBaseUrl: string;
      workspaceFolder: string;
      sessionId: string;
      shipper: StepExecutionLogShipper;
      // eslint-disable-next-line local/no-unknown-parameter-type
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.stopped || this.abortController !== null) {
      return;
    }
    this.abortController = new AbortController();
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const client = createOpencodeClient({
        baseUrl: this.deps.agentBaseUrl,
        directory: this.deps.workspaceFolder,
      });
      const subscription = await client.event.subscribe();
      for await (const event of subscription.stream) {
        if (this.stopped) {
          break;
        }
        this.handleEvent(event);
      }
    } catch (error) {
      if (!this.stopped) {
        this.deps.onError?.(error);
      }
    }
  }

  private handleEvent(event: {
    type: string;
    properties: Record<string, unknown>;
  }): void {
    switch (event.type) {
      case "message.updated": {
        const info = (event.properties as { info?: unknown }).info;
        if (!isMessageInfo(info)) return;
        if (info.sessionID !== this.deps.sessionId) return;
        const message = info as Message;
        const conversationEvent = messageToConversationEvent(message);
        this.rolesByMessageId.set(message.id, conversationEvent.role);
        this.enqueue(conversationEvent);
        return;
      }
      case "message.part.updated": {
        const rawPart = (event.properties as { part?: unknown }).part;
        if (!isPart(rawPart)) return;
        if (rawPart.sessionID !== this.deps.sessionId) return;
        const part = rawPart as Part;
        const role = this.rolesByMessageId.get(part.messageID) ?? "assistant";
        const conversationEvent = partToConversationEvent(part, role);
        if (!conversationEvent) return;
        if (
          conversationEvent.kind === "text" ||
          conversationEvent.kind === "reasoning"
        ) {
          this.debouncePart(conversationEvent.partId, conversationEvent);
        } else {
          this.enqueue(conversationEvent);
        }
        return;
      }
      case "session.error": {
        const sessionId = (event.properties as { sessionID?: unknown })
          .sessionID;
        if (typeof sessionId === "string" && sessionId !== this.deps.sessionId) {
          return;
        }
        const conversationEvent = sessionErrorEventToConversationEvent(
          event as Parameters<typeof sessionErrorEventToConversationEvent>[0],
        );
        if (conversationEvent) {
          this.enqueue(conversationEvent);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Coalesce a streaming text/reasoning part: replace any pending snapshot for
   * the same `partId` and (re)arm a short timer so only the latest full text is
   * shipped once the burst settles.
   */
  private debouncePart(partId: string, event: ConversationEvent): void {
    const existing = this.pendingParts.get(partId);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pendingParts.delete(partId);
      this.enqueue(event);
    }, TEXT_PART_DEBOUNCE_MS);
    // Don't keep the event loop alive solely for a pending part flush.
    timer.unref();
    this.pendingParts.set(partId, { event, timer });
  }

  private enqueue(event: ConversationEvent): void {
    if (this.stopped) return;
    this.deps.shipper.enqueue("conversation", JSON.stringify(event));
  }

  /** Flush any pending debounced parts and stop consuming the SSE stream. */
  stop(): void {
    this.stopped = true;
    for (const [, pending] of this.pendingParts) {
      clearTimeout(pending.timer);
      // Flush the latest snapshot so the final text isn't lost on shutdown.
      this.deps.shipper.enqueue("conversation", JSON.stringify(pending.event));
    }
    this.pendingParts.clear();
    this.abortController?.abort();
    this.abortController = null;
  }
}

// Narrow SSE payloads structurally so this stays decoupled from generated SDK
// event unions (which the streamer receives as a discriminated `type` string).

// eslint-disable-next-line local/no-unknown-parameter-type
function isMessageInfo(value: unknown): value is {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number };
  modelID?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { sessionID?: unknown }).sessionID === "string" &&
    typeof (value as { role?: unknown }).role === "string"
  );
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isPart(value: unknown): value is {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { sessionID?: unknown }).sessionID === "string" &&
    typeof (value as { messageID?: unknown }).messageID === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
