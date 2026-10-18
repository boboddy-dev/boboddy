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
    startActivity: (m) => {
      calls.push(`startActivity:${m}`);
      return {
        update: (next) => calls.push(`activity.update:${next}`),
        succeed: (next) => calls.push(`activity.succeed:${next ?? ""}`),
        fail: (next) => calls.push(`activity.fail:${next ?? ""}`),
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
    };
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

    const taskA = reporter.startActivity("first");
    const taskB = reporter.startActivity("second");
    taskB.update("second update");
    taskA.succeed("first done");
    taskB.fail();

    expect(forwarded).toEqual([
      "startActivity:first",
      "startActivity:second",
      "activity.update:second update",
      "activity.succeed:first done",
      "activity.fail:",
    ]);

    const recorded = readRecorded(filePath);
    expect(recorded).toMatchObject([
      { method: "startActivity", args: ["first"], activityId: 0 },
      { method: "startActivity", args: ["second"], activityId: 1 },
      { method: "activity:update", args: ["second update"], activityId: 1 },
      { method: "activity:succeed", args: ["first done"], activityId: 0 },
      { method: "activity:fail", args: [], activityId: 1 },
    ]);
  });
});
