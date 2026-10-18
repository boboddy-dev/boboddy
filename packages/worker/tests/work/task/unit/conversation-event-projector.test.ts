import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { V2Event } from "@opencode/client";
import {
  ConversationEventProjector,
  type ProjectedConversationEvent,
} from "../../../../src/work/task/application/conversation-event";

/**
 * `opencode-v2-event-stream.json` is a real OpenCode 2.0.28 `/api/event`
 * capture of three fake-AI health-check sessions (shell exit 3, the plugin
 * submit tool, and an unknown tool). The golden file is the projector output
 * per session, reviewed by hand.
 */
const FIXTURES = join(import.meta.dir, "fixtures");

const readFixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

const events = JSON.parse(
  readFixture("opencode-v2-event-stream.json"),
) as V2Event[];
const golden = JSON.parse(
  readFixture("opencode-v2-event-stream.golden.json"),
) as Record<string, ProjectedConversationEvent[]>;

const SHELL_SESSION = "ses_ec8f0ff9affertc3ICs5UeZa1u";
const SUBMIT_SESSION = "ses_ec8f0f974ffeN5Evy2a5loEedS";
const MISSING_TOOL_SESSION = "ses_ec8f0f34dffeHOC2B2xnGQ13e0";

const projectAll = (
  sessionId: string,
  stream: readonly V2Event[],
): ProjectedConversationEvent[] => {
  const projector = new ConversationEventProjector(sessionId);
  return stream.flatMap((event) => projector.project(event));
};

const failureEvent = (
  type: "session.step.failed" | "session.execution.failed",
  sessionID: string,
  error: { type: string; message: string },
): V2Event =>
  ({
    id: `evt_${type}`,
    created: 0,
    type,
    durable: { aggregateID: sessionID, seq: 0, version: 1 },
    data: { sessionID, assistantMessageID: "msg_1", error },
  }) as unknown as V2Event;

describe("ConversationEventProjector", () => {
  test.each([SHELL_SESSION, SUBMIT_SESSION, MISSING_TOOL_SESSION])(
    "projects the captured v2 stream for %s to the golden output",
    (sessionId) => {
      expect(projectAll(sessionId, events)).toEqual(golden[sessionId] ?? []);
    },
  );

  test("golden output covers every captured session", () => {
    const created = events
      .filter((event) => event.type === "session.created")
      .map((event) => (event.data as { sessionID: string }).sessionID);
    expect(Object.keys(golden).sort()).toEqual([...created].sort());
  });

  test("tool results render text content and structured errors", () => {
    const toolEvents = (sessionId: string) =>
      projectAll(sessionId, events)
        .map(({ event }) => event)
        .filter((event) => event.kind === "tool");

    expect(toolEvents(SHELL_SESSION).map((event) => event.status)).toEqual([
      "pending",
      "running",
      "completed",
    ]);
    expect(toolEvents(SHELL_SESSION).at(-1)).toMatchObject({
      tool: "shell",
      output: "hi\n\nExited with code 3",
    });
    expect(toolEvents(MISSING_TOOL_SESSION).at(-1)).toMatchObject({
      tool: "no-such-tool",
      status: "error",
      error:
        'tool.execution: No tool named "no-such-tool" is currently available. Please use a tool from the available tool list.',
    });
  });

  test("ignores events for other sessions", () => {
    expect(projectAll("ses_unrelated", events)).toEqual([]);
  });

  test("ships a step failure followed by the same execution failure once", () => {
    const error = { type: "provider.internal", message: "boom" };
    expect(
      projectAll("ses_a", [
        failureEvent("session.step.failed", "ses_a", error),
        failureEvent("session.execution.failed", "ses_a", error),
      ]),
    ).toEqual([
      {
        event: { kind: "session-error", message: "provider.internal: boom" },
        streaming: false,
      },
    ]);
  });

  test("treats an interrupted step as not an error", () => {
    expect(
      projectAll("ses_a", [
        failureEvent("session.step.failed", "ses_a", {
          type: "aborted",
          message: "Step interrupted",
        }),
      ]),
    ).toEqual([]);
  });
});
