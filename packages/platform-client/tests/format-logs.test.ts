import { describe, expect, test } from "bun:test";
import { formatLogs, MAX_LOG_RENDER_CHARS } from "../src/format-logs";
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
    expect(live).toContain("live, step still running");
  });

  test("renders worker/ai-server lines as [level] ts content", () => {
    const output = formatLogs({
      stepKey: "investigate",
      lines: [
        line({ seq: 1, stream: "worker", level: "warn", content: "lease renewed" }),
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
      { kind: "text", messageId: "msg-1", partId: "part-1", role: "assistant", text: "Look" },
      { kind: "text", messageId: "msg-1", partId: "part-1", role: "assistant", text: "Looking into it" },
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
      line({ seq: index, stream: "conversation", content: JSON.stringify(event) }),
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

  test("truncates output past the render cap with an explicit notice", () => {
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

    expect(output.length).toBeLessThanOrEqual(
      MAX_LOG_RENDER_CHARS + 100,
    );
    expect(output).toContain("[truncated,");
  });
});
