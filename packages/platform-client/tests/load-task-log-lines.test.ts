import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  loadTaskLogLines,
  type TaskLogsClient,
} from "../src/load-task-log-lines";
import type { LogLine } from "../src/lib/api-types";

const headers = { Authorization: "Bearer test-token" };

const archivedLine: LogLine = {
  seq: 0,
  stream: "conversation",
  ts: "2026-01-01T00:00:00.000Z",
  content: "archived",
  level: "info",
};

const liveLine: LogLine = {
  seq: 0,
  stream: "worker",
  ts: "2026-01-01T00:00:00.000Z",
  content: "live",
  level: "info",
};

let archiveServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  archiveServer = Bun.serve({
    port: 0,
    fetch: () => new Response(`${JSON.stringify(archivedLine)}\nnot json\n`),
  });
});

afterAll(() => {
  void archiveServer.stop(true);
});

function buildClient(
  overrides: Partial<TaskLogsClient["tasks"]> = {},
): TaskLogsClient {
  return {
    tasks: {
      getTaskLogArchive: () =>
        Promise.resolve({
          data: { url: archiveServer.url.href, sizeBytes: 1 },
          error: undefined,
        }),
      readTaskLogs: () =>
        Promise.resolve({
          data: { lines: [liveLine], nextOffset: 1, complete: false },
          error: undefined,
        }),
      ...overrides,
    },
  };
}

describe("loadTaskLogLines", () => {
  test.concurrent("reads the archive for a completed task", async () => {
    const result = await loadTaskLogLines(buildClient(), headers, {
      id: "task-1",
      completedAt: "2026-01-01T00:05:00.000Z",
    });

    expect(result).toEqual({ lines: [archivedLine], source: "archive" });
  });

  test.concurrent("reads the live feed for a running task", async () => {
    const result = await loadTaskLogLines(buildClient(), headers, {
      id: "task-1",
      completedAt: null,
    });

    expect(result).toEqual({ lines: [liveLine], source: "live" });
  });

  test.concurrent(
    "reports the read quota as unavailable on a 402",
    async () => {
      const client = buildClient({
        getTaskLogArchive: () =>
          Promise.resolve({
            data: undefined,
            error: { status: 402, title: "Payment Required" },
          }),
      });

      const result = await loadTaskLogLines(client, headers, {
        id: "task-1",
        completedAt: "2026-01-01T00:05:00.000Z",
      });

      expect(result).toEqual({
        unavailable: expect.stringContaining(
          "log archive read quota exceeded",
        ) as string,
      });
    },
  );

  test.concurrent(
    "reports unavailable when the archive has no presigned URL",
    async () => {
      const client = buildClient({
        getTaskLogArchive: () =>
          Promise.resolve({
            data: { url: null, sizeBytes: 0 },
            error: undefined,
          }),
      });

      const result = await loadTaskLogLines(client, headers, {
        id: "task-1",
        completedAt: "2026-01-01T00:05:00.000Z",
      });

      expect(result).toEqual({
        unavailable: expect.stringContaining(
          "no log archive is available",
        ) as string,
      });
    },
  );

  test.concurrent("reports unavailable when the live feed fails", async () => {
    const client = buildClient({
      readTaskLogs: () =>
        Promise.resolve({
          data: undefined,
          error: { status: 500, title: "Internal Server Error" },
        }),
    });

    const result = await loadTaskLogLines(client, headers, {
      id: "task-1",
      completedAt: null,
    });

    expect(result).toEqual({
      unavailable: expect.stringContaining(
        "could not load live logs",
      ) as string,
    });
  });
});
