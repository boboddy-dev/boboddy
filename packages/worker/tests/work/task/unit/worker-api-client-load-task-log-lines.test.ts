/**
 * The real worker client's `loadTaskLogLines`: fetches the Task for its
 * `completedAt`, then reads the archive (completed) or the live feed (still
 * running) through `@boboddy/platform-client`, surfacing API errors such as a
 * 402 read quota as `{ unavailable }`.
 */
import { describe, expect, test, vi } from "bun:test";
import { buildLoadTaskLogLines } from "../../../../src/work/task/infra/worker-api-client";

const TASK_ID = "0199a000-0000-7000-8000-000000000002";
const LINE = {
  seq: 1,
  stream: "conversation" as const,
  ts: "2026-10-16T10:00:00.000Z",
  content: "{}",
  level: "info" as const,
};

function planeClient(input: {
  completedAt: string | null;
  archive?: unknown;
  live?: unknown;
}) {
  const getTaskLogArchive = vi.fn(() => Promise.resolve(input.archive));
  const readTaskLogs = vi.fn(() => Promise.resolve(input.live));
  return {
    getTaskLogArchive,
    readTaskLogs,
    client: {
      getTask: vi.fn(() =>
        Promise.resolve({ id: TASK_ID, completedAt: input.completedAt }),
      ),
      getTaskLogArchive,
      readTaskLogs,
    } as unknown as Parameters<typeof buildLoadTaskLogLines>[0],
  };
}

describe("buildLoadTaskLogLines", () => {
  test("reads the live feed for a Task that has not completed", async () => {
    const fake = planeClient({
      completedAt: null,
      live: {
        data: { lines: [LINE], nextOffset: 1, complete: false },
        error: undefined,
      },
    });

    const result = await buildLoadTaskLogLines(fake.client)({
      taskId: TASK_ID,
    });

    expect(result).toEqual({ lines: [LINE], source: "live" });
    expect(fake.readTaskLogs).toHaveBeenCalledWith({
      taskId: TASK_ID,
      from: 0,
      limit: 2_000,
    });
    expect(fake.getTaskLogArchive).not.toHaveBeenCalled();
  });

  test("reports a 402 read quota on the archive of a completed Task as unavailable", async () => {
    const fake = planeClient({
      completedAt: "2026-10-16T09:00:00.000Z",
      archive: { data: undefined, error: { status: 402 } },
    });

    const result = await buildLoadTaskLogLines(fake.client)({
      taskId: TASK_ID,
    });

    expect(result).toMatchObject({
      unavailable: expect.stringContaining("402") as unknown,
    });
    expect(fake.getTaskLogArchive).toHaveBeenCalledWith({ taskId: TASK_ID });
    expect(fake.readTaskLogs).not.toHaveBeenCalled();
  });

  test("reports a completed Task without a presigned archive URL as unavailable", async () => {
    const fake = planeClient({
      completedAt: "2026-10-16T09:00:00.000Z",
      archive: { data: { url: null, sizeBytes: 0 }, error: undefined },
    });

    const result = await buildLoadTaskLogLines(fake.client)({
      taskId: TASK_ID,
    });

    expect(result).toHaveProperty("unavailable");
  });
});
