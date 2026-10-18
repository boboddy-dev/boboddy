/**
 * Unit test for {@link OpencodeConversationStreamer}: replays the real v2
 * `/api/event` capture (`fixtures/opencode-v2-event-stream.json`) over a fake
 * SSE response and asserts what reaches the shipper. Streaming text snapshots
 * are superseded by the settled `*.ended` text, so the shipped lines are the
 * golden projection minus its streaming entries.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { OpencodeConversationStreamer } from "../../../../src/work/task/application/opencode-conversation-streamer";
import type { ProjectedConversationEvent } from "../../../../src/work/task/application/conversation-event";
import type { TaskLogShipper } from "../../../../src/work/task/application/task-log-shipper";

const FIXTURES = join(import.meta.dir, "fixtures");
const SESSION_ID = "ses_ec8f0ff9affertc3ICs5UeZa1u";

const events = JSON.parse(
  readFileSync(join(FIXTURES, "opencode-v2-event-stream.json"), "utf8"),
) as unknown[];
const golden = JSON.parse(
  readFileSync(join(FIXTURES, "opencode-v2-event-stream.golden.json"), "utf8"),
) as Record<string, ProjectedConversationEvent[]>;

const SERVER = {
  baseUrl: "http://127.0.0.1:4096",
  password: "test-password",
  workspaceFolder: "/workspace",
};

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

function sseResponse(payloads: readonly unknown[]): Response {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor: condition not met within ${String(timeoutMs)}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createFakeShipper(): {
  shipper: TaskLogShipper;
  lines: { stream: string; content: string }[];
} {
  const lines: { stream: string; content: string }[] = [];
  const shipper: Pick<TaskLogShipper, "enqueue"> = {
    enqueue: (stream, content) => {
      lines.push({ stream, content });
    },
  };
  return { shipper: shipper as TaskLogShipper, lines };
}

describe("OpencodeConversationStreamer", () => {
  test("ships the settled projection of the monitored session from GET /api/event", async () => {
    const requests: { pathname: string; authorization: string | null }[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({
        pathname: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(sseResponse(events));
    }) as typeof fetch;

    const expected = (golden[SESSION_ID] ?? [])
      .filter((projected) => !projected.streaming)
      .map((projected) => JSON.stringify(projected.event));

    const { shipper, lines } = createFakeShipper();
    const errors: unknown[] = [];
    const streamer = new OpencodeConversationStreamer({
      server: SERVER,
      sessionId: SESSION_ID,
      shipper,
      onError: (error) => errors.push(error),
    });
    streamer.start();

    await waitFor(() => lines.length >= expected.length);
    await new Promise((resolve) => setTimeout(resolve, 300));
    streamer.stop();

    expect(errors).toEqual([]);
    expect(requests.map((request) => request.pathname)).toEqual(["/api/event"]);
    expect(requests[0]?.authorization).toBe(
      `Basic ${btoa("opencode:test-password")}`,
    );
    expect(lines.every((line) => line.stream === "conversation")).toBe(true);
    expect(lines.map((line) => line.content)).toEqual(expected);
  });

  test("reports a failed subscription through onError without throwing", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("nope", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const { shipper, lines } = createFakeShipper();
    const errors: unknown[] = [];
    const streamer = new OpencodeConversationStreamer({
      server: SERVER,
      sessionId: SESSION_ID,
      shipper,
      onError: (error) => errors.push(error),
    });
    streamer.start();

    await waitFor(() => errors.length > 0);
    streamer.stop();

    expect(lines).toEqual([]);
  });
});
