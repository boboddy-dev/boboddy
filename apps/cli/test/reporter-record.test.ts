import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRecordingReporter,
  type RecordedReporterCall,
} from "../src/lib/reporter-record";
import type { CliReporter, WorkEvent } from "../src/lib/reporter-types";

function createSpyReporter(calls: string[]): CliReporter {
  return {
    start: (m) => calls.push(`start:${m}`),
    finish: (m) => calls.push(`finish:${m}`),
    info: (m) => calls.push(`info:${m}`),
    success: (m) => calls.push(`success:${m}`),
    warn: (m) => calls.push(`warn:${m}`),
    error: (m) => calls.push(`error:${m}`),
    event: (e) => calls.push(`event:${e.type}`),
    startTask: (m) => {
      calls.push(`startTask:${m}`);
      return {
        update: (next) => calls.push(`task.update:${next}`),
        succeed: (next) => calls.push(`task.succeed:${next ?? ""}`),
        fail: (next) => calls.push(`task.fail:${next ?? ""}`),
      };
    },
  };
}

function readRecorded(filePath: string): RecordedReporterCall[] {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RecordedReporterCall);
}

describe("createRecordingReporter", () => {
  test("records every call as JSONL and forwards to the inner reporter", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reporter-record-"));
    const filePath = path.join(dir, "nested", "calls.jsonl");
    const forwarded: string[] = [];
    const reporter = createRecordingReporter(createSpyReporter(forwarded), filePath);

    const before = Date.now();
    reporter.start("Boboddy worker");
    reporter.info("hello");
    const event: WorkEvent = {
      type: "worker:claimed",
      count: 2,
    } as WorkEvent;
    reporter.event(event);
    reporter.finish("Done");

    expect(forwarded).toEqual([
      "start:Boboddy worker",
      "info:hello",
      "event:worker:claimed",
      "finish:Done",
    ]);

    const recorded = readRecorded(filePath);
    expect(recorded.map((c) => c.method)).toEqual([
      "start",
      "info",
      "event",
      "finish",
    ]);
    expect(recorded[0]?.args).toEqual(["Boboddy worker"]);
    expect(recorded[2]?.args).toEqual([{ type: "worker:claimed", count: 2 }]);
    for (const call of recorded) {
      expect(call.t).toBeGreaterThanOrEqual(before);
      expect(call.t).toBeLessThanOrEqual(Date.now());
    }
  });

  test("assigns incrementing task ids and records task handle calls", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reporter-record-"));
    const filePath = path.join(dir, "calls.jsonl");
    const forwarded: string[] = [];
    const reporter = createRecordingReporter(createSpyReporter(forwarded), filePath);

    const taskA = reporter.startTask("first");
    const taskB = reporter.startTask("second");
    taskB.update("second update");
    taskA.succeed("first done");
    taskB.fail();

    expect(forwarded).toEqual([
      "startTask:first",
      "startTask:second",
      "task.update:second update",
      "task.succeed:first done",
      "task.fail:",
    ]);

    const recorded = readRecorded(filePath);
    expect(recorded).toMatchObject([
      { method: "startTask", args: ["first"], taskId: 0 },
      { method: "startTask", args: ["second"], taskId: 1 },
      { method: "task:update", args: ["second update"], taskId: 1 },
      { method: "task:succeed", args: ["first done"], taskId: 0 },
      { method: "task:fail", args: [], taskId: 1 },
    ]);
  });
});
