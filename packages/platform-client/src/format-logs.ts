import type {
  ConversationEvent,
  LogLine,
  StepExecutionLogStream,
} from "./lib/api-types";

/** Cap on the total rendered log output, per the plan's Risks table ("Cap
 * rendered output size explicitly in the formatters ... rather than relying
 * on callers to notice"). 20k chars is generous for a terminal/agent to read
 * in one response while still bounding worst-case output for a long-running
 * step with `--log` defaulting to all three streams. */
export const MAX_LOG_RENDER_CHARS = 20_000;

export type FormatLogsInput = {
  stepKey: string;
  /** Log lines already filtered to the requested stream(s) by the caller,
   * in `seq` order. */
  lines: readonly LogLine[];
  requestedStream: StepExecutionLogStream | "all";
  /** Where `lines` came from: the durable archive (step execution is
   * terminal) or the live feed (still running). Purely informational —
   * shown in the header so the reader knows whether this is a final or
   * in-progress record. */
  source: "archive" | "live";
};

const STREAM_ORDER: readonly StepExecutionLogStream[] = [
  "worker",
  "ai-server",
  "conversation",
];

function renderPlainLine(line: LogLine): string {
  return `[${line.level}] ${line.ts} ${line.content}`;
}

type ConversationEntry = { order: number; render: () => string[] };

function renderToolEvent(
  event: Extract<ConversationEvent, { kind: "tool" }>,
): string[] {
  const header = `[tool] ${event.tool} — ${event.status}${
    event.title ? `: ${event.title}` : ""
  }`;
  const rendered = [header];
  if (event.output !== undefined) rendered.push(`  output: ${event.output}`);
  if (event.error !== undefined) rendered.push(`  error: ${event.error}`);
  return rendered;
}

/**
 * Reconstructs a chat-transcript-ish view of the `conversation` stream.
 * OpenCode resends the full part on every streaming update (see
 * `conversationEventSchema`'s doc comment in
 * `step-execution-log-contracts.ts`), so this upserts by `partId`/a synthetic
 * key exactly like the UI does — keeping only the LATEST content per part,
 * but rendered in the ORDER the part first appeared, rather than replaying
 * every intermediate streaming delta (which would be unreadable as flat
 * text). `step-finish`/`session-error` events have no `partId`; each gets
 * its own one-shot entry keyed by its own position.
 */
function renderConversationLines(lines: readonly LogLine[]): string[] {
  const messageRoles = new Map<string, "user" | "assistant">();
  const entries = new Map<string, ConversationEntry>();
  let orderCounter = 0;

  for (const line of lines) {
    let event: ConversationEvent;
    try {
      event = JSON.parse(line.content) as ConversationEvent;
    } catch {
      entries.set(`raw:${String(orderCounter)}`, {
        order: orderCounter++,
        render: () => [`[conversation] ${line.content}`],
      });
      continue;
    }

    switch (event.kind) {
      case "message": {
        messageRoles.set(event.id, event.role);
        break;
      }
      case "text": {
        const key = `part:${event.partId}`;
        const order = entries.get(key)?.order ?? orderCounter++;
        const role = messageRoles.get(event.messageId) ?? event.role;
        entries.set(key, { order, render: () => [`[${role}] ${event.text}`] });
        break;
      }
      case "reasoning": {
        const key = `part:${event.partId}`;
        const order = entries.get(key)?.order ?? orderCounter++;
        entries.set(key, {
          order,
          render: () => [`[reasoning] ${event.text}`],
        });
        break;
      }
      case "tool": {
        const key = `part:${event.partId}`;
        const order = entries.get(key)?.order ?? orderCounter++;
        entries.set(key, { order, render: () => renderToolEvent(event) });
        break;
      }
      case "step-finish": {
        const key = `step-finish:${String(orderCounter)}`;
        entries.set(key, {
          order: orderCounter++,
          render: () => [
            `[usage] cost=$${String(event.cost)} tokens(input=${String(
              event.tokens.input,
            )}, output=${String(event.tokens.output)}, reasoning=${String(
              event.tokens.reasoning,
            )})`,
          ],
        });
        break;
      }
      case "session-error": {
        const key = `session-error:${String(orderCounter)}`;
        entries.set(key, {
          order: orderCounter++,
          render: () => [`[session error] ${event.message}`],
        });
        break;
      }
    }
  }

  return [...entries.values()]
    .sort((left, right) => left.order - right.order)
    .flatMap((entry) => entry.render());
}

function renderStreamBlock(
  stream: StepExecutionLogStream,
  lines: readonly LogLine[],
): string[] {
  if (lines.length === 0) return [];
  const body =
    stream === "conversation"
      ? renderConversationLines(lines)
      : lines.map(renderPlainLine);
  return [`== ${stream} ==`, ...body, ""];
}

function truncateToCap(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const omitted = text.length - cap;
  return `${text.slice(0, cap)}\n… [truncated, ${String(omitted)} more characters]`;
}

/**
 * Decision 10's `--log` output: all three streams by default (or the one
 * named by `--log-stream`), rendered in a human-readable parsed form rather
 * than raw JSONL, capped to {@link MAX_LOG_RENDER_CHARS}.
 */
export function formatLogs(input: FormatLogsInput): string {
  const { stepKey, lines, requestedStream, source } = input;
  const streamsToRender =
    requestedStream === "all" ? STREAM_ORDER : [requestedStream];

  const header = [
    `Logs for step ${stepKey} (${source === "archive" ? "complete" : "live, step still running"})`,
    "",
  ];

  if (lines.length === 0) {
    return [...header, "(no log lines yet)"].join("\n");
  }

  const body: string[] = [];
  for (const stream of streamsToRender) {
    const streamLines = lines.filter((line) => line.stream === stream);
    body.push(...renderStreamBlock(stream, streamLines));
  }

  const rendered = [...header, ...body].join("\n").trimEnd();
  return truncateToCap(rendered, MAX_LOG_RENDER_CHARS);
}
