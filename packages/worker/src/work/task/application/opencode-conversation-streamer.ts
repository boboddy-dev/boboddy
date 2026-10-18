import type { OpencodeServerHandle } from "../contracts/process-project-work-types";
import { createBoboddyOpencodeClient } from "../infra/opencode-client";
import type { TaskLogShipper } from "./task-log-shipper";
import {
  ConversationEventProjector,
  type ConversationEvent,
} from "./conversation-event";

/**
 * Subscribes to the OpenCode v2 event stream (SSE) and ships a structured
 * projection of the agent conversation into a {@link TaskLogShipper}
 * as the `conversation` stream.
 *
 * Mirrors {@link OpencodeLogTail}'s lifecycle and best-effort contract: a failed
 * subscription is reported via `onError` and never throws, since conversation
 * capture must not break the task. Only events for the monitored
 * `sessionId` are forwarded (see {@link ConversationEventProjector}).
 *
 * Streaming text/reasoning arrives as a burst of delta events (one per token
 * chunk). To avoid shipping one log line per token, those snapshots are
 * debounced per `partId`: the latest full text is enqueued after a short quiet
 * window. Settled events (including the final `*.ended` text) ship
 * immediately and replace any pending snapshot for the same part.
 */
const TEXT_PART_DEBOUNCE_MS = 250;

export class OpencodeConversationStreamer {
  private stopped = false;
  private abortController: AbortController | null = null;
  private readonly projector: ConversationEventProjector;
  /** Pending debounced text/reasoning snapshots keyed by partId. */
  private readonly pendingParts = new Map<
    string,
    { event: ConversationEvent; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly deps: {
      server: OpencodeServerHandle;
      sessionId: string;
      shipper: TaskLogShipper;
      // eslint-disable-next-line local/no-unknown-parameter-type
      onError?: (error: unknown) => void;
    },
  ) {
    this.projector = new ConversationEventProjector(deps.sessionId);
  }

  start(): void {
    if (this.stopped || this.abortController !== null) {
      return;
    }
    this.abortController = new AbortController();
    void this.run(this.abortController.signal);
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      const client = createBoboddyOpencodeClient(this.deps.server);
      for await (const event of client.event.subscribe({ signal })) {
        if (this.stopped) {
          break;
        }
        for (const projected of this.projector.project(event)) {
          if (projected.streaming && "partId" in projected.event) {
            this.debouncePart(projected.event.partId, projected.event);
          } else {
            this.settle(projected.event);
          }
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.deps.onError?.(error);
      }
    }
  }

  /**
   * Coalesce a streaming text/reasoning snapshot: replace any pending snapshot
   * for the same `partId` and (re)arm a short timer so only the latest full
   * text is shipped once the burst settles.
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

  private settle(event: ConversationEvent): void {
    if ("partId" in event) {
      const pending = this.pendingParts.get(event.partId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingParts.delete(event.partId);
      }
    }
    this.enqueue(event);
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
