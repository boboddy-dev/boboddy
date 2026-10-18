import { describe, expect, test } from "bun:test";
import {
  capLogBody,
  formatLogs,
  MAX_LOG_RENDER_CHARS,
  renderConversationTranscript,
  renderLogText,
  withFullLogLocation,
} from "../src/format-logs";
import type { LogLine } from "../src/lib/api-types";

function line(overrides: Partial<LogLine>): LogLine {
  return {
    seq: 0,
    stream: "worker",
    ts: "2026-01-01T00:00:00.000Z",
    content: "hello",
    level: "info",
    ...overrides,
  };
}

describe("formatLogs", () => {
  test("reports when there are no log lines yet", () => {
    const output = formatLogs({
      stepKey: "investigate",
      lines: [],
      requestedStream: "all",
      source: "live",
    });
    expect(output).toContain("(no log lines yet)");
  });

  test("labels the header with archive vs live source", () => {
    const archived = formatLogs({
      stepKey: "investigate",
      lines: [line({ seq: 1 })],
      requestedStream: "all",
      source: "archive",
    });
    expect(archived).toContain("complete");

    const live = formatLogs({
      stepKey: "investigate",
      lines: [line({ seq: 1 })],
      requestedStream: "all",
      source: "live",
    });
    expect(live).toContain("(live snapshot, step still running)");
  });

  test("renders worker/ai-server lines as [level] ts content", () => {
    const output = formatLogs({
      stepKey: "investigate",
      lines: [
        line({
          seq: 1,
          stream: "worker",
          level: "warn",
          content: "lease renewed",
        }),
      ],
      requestedStream: "all",
      source: "live",
    });
    expect(output).toContain("== worker ==");
    expect(output).toContain("[warn] 2026-01-01T00:00:00.000Z lease renewed");
  });

  test("narrows to a single stream via requestedStream", () => {
    const output = formatLogs({
      stepKey: "investigate",
      lines: [
        line({ seq: 1, stream: "worker", content: "worker line" }),
        line({ seq: 2, stream: "ai-server", content: "ai line" }),
      ],
      requestedStream: "worker",
      source: "live",
    });
    expect(output).toContain("worker line");
    expect(output).not.toContain("ai line");
    expect(output).not.toContain("== ai-server ==");
  });

  test("renders a conversation transcript, deduping streamed part updates by partId", () => {
    const events = [
      { kind: "message", id: "msg-1", role: "assistant", createdMs: 1 },
      {
        kind: "text",
        messageId: "msg-1",
        partId: "part-1",
        role: "assistant",
        text: "Look",
      },
      {
        kind: "text",
        messageId: "msg-1",
        partId: "part-1",
        role: "assistant",
        text: "Looking into it",
      },
      {
        kind: "tool",
        messageId: "msg-1",
        partId: "part-2",
        callId: "call-1",
        tool: "bash",
        status: "completed",
        title: "run tests",
        output: "3 passed",
      },
      {
        kind: "step-finish",
        messageId: "msg-1",
        cost: 0.02,
        tokens: { input: 100, output: 50, reasoning: 0 },
      },
    ];
    const lines = events.map((event, index) =>
      line({
        seq: index,
        stream: "conversation",
        content: JSON.stringify(event),
      }),
    );

    const output = formatLogs({
      stepKey: "investigate",
      lines,
      requestedStream: "conversation",
      source: "archive",
    });

    // Only the FINAL text update should appear, not the intermediate one.
    expect(output).toContain("[assistant] Looking into it");
    expect(output).not.toContain("[assistant] Look\n");
    expect(output).toContain("[tool] bash — completed: run tests");
    expect(output).toContain("output: 3 passed");
    expect(output).toContain("[usage] cost=$0.02");
  });

  test("falls back to raw content when a conversation line is not valid JSON", () => {
    const output = formatLogs({
      stepKey: "investigate",
      lines: [line({ stream: "conversation", content: "not json" })],
      requestedStream: "conversation",
      source: "archive",
    });
    expect(output).toContain("[conversation] not json");
  });

  test("truncates output past the render cap with an explicit notice, keeping the tail", () => {
    const longLines = Array.from({ length: 2_000 }, (_, index) =>
      line({
        seq: index,
        stream: "worker",
        content: `line number ${String(index)} `.repeat(5),
      }),
    );

    const output = formatLogs({
      stepKey: "investigate",
      lines: longLines,
      requestedStream: "all",
      source: "archive",
    });

    expect(output.length).toBeLessThanOrEqual(MAX_LOG_RENDER_CHARS);

    const [header, blank, note, firstShownLine] = output.split("\n");
    expect(header).toBe("Logs for step investigate (complete)");
    expect(blank).toBe("");
    expect(note).toMatch(
      /^… \d{1,3}(,\d{3})+ earlier characters omitted \(see full log above\)$/,
    );
    expect(firstShownLine).toMatch(/^\[info\] .* line number \d+ .*$/);

    expect(output).toContain("line number 1999");
    expect(output).not.toContain("line number 0 ");
  });

  test("capLogBody leaves short text untouched", () => {
    const short = "Logs for step investigate (complete)\n\nline one\nline two";
    expect(capLogBody(short, MAX_LOG_RENDER_CHARS)).toBe(short);
  });

  test("capLogBody's note counts exactly the characters it dropped", () => {
    const header = "Logs for step investigate (complete)\n\n";
    const body = Array.from(
      { length: 1_000 },
      (_, index) => `line ${String(index)}`,
    ).join("\n");

    const capped = capLogBody(header + body, 500);
    const [, noteAndTail] = capped.split(header);
    const [note = "", ...tail] = (noteAndTail ?? "").split("\n");
    const omitted = Number(/^… ([\d,]+) /.exec(note)?.[1]?.replace(/,/g, ""));
    expect(omitted + tail.join("\n").length).toBe(body.length);
  });

  test("withFullLogLocation puts the location on the header line", () => {
    const rendered = "Logs for step investigate (complete)\n\nline one";
    expect(withFullLogLocation(rendered, "/tmp/task-all.log")).toBe(
      "Logs for step investigate (complete) · full log: /tmp/task-all.log\n\nline one",
    );
  });

  test("renderLogText/capLogBody are directly testable in isolation", () => {
    const rendered = renderLogText({
      stepKey: "investigate",
      lines: [line({ seq: 1, content: "hello" })],
      requestedStream: "all",
      source: "live",
    });
    expect(rendered).toContain("Logs for step investigate");
    expect(rendered.length).toBeLessThanOrEqual(MAX_LOG_RENDER_CHARS);

    expect(capLogBody(rendered, MAX_LOG_RENDER_CHARS)).toBe(rendered);
    const capped = capLogBody(rendered, 10);
    expect(capped).toContain("earlier characters omitted");
  });
});

describe("renderConversationTranscript", () => {
  test("renders only the conversation stream, uncapped", () => {
    const longText = "x".repeat(MAX_LOG_RENDER_CHARS * 2);
    const transcript = renderConversationTranscript({
      stepKey: "investigate",
      lines: [
        line({ seq: 0, stream: "worker", content: "worker noise" }),
        line({
          seq: 1,
          stream: "conversation",
          content: JSON.stringify({
            kind: "text",
            partId: "part-1",
            messageId: "message-1",
            role: "assistant",
            text: longText,
          }),
        }),
      ],
      source: "archive",
    });

    expect(transcript).not.toContain("worker noise");
    expect(transcript).toContain("== conversation ==");
    expect(transcript).toContain(`[assistant] ${longText}`);
    expect(transcript).not.toContain("earlier characters omitted");
  });
});
