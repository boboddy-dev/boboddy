import { describe, expect, it } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { StepExecutionLogStream } from "../../../../src/work/step-execution/application/start-step-execution-log-streaming";
import type {
  ProjectWorkLogger,
  StepExecutionLogLine,
  StepExecutionWorkerClient,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";

const buildWorkerClient = (
  sink: StepExecutionLogLine[],
): Pick<StepExecutionWorkerClient, "appendStepExecutionLogs"> => ({
  appendStepExecutionLogs: (input) => {
    sink.push(...input.lines);
    return Promise.resolve({ nextOffset: input.lines.at(-1)?.seq ?? 0 });
  },
});

describe("StepExecutionLogStream", () => {
  it("tees worker logger lines into the feed as the worker stream", async () => {
    const sent: StepExecutionLogLine[] = [];
    const baseCalls: string[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: (scope, message) => baseCalls.push(`debug:${scope}:${message}`),
      log: (scope, message) => baseCalls.push(`log:${scope}:${message}`),
      error: (scope, message) => baseCalls.push(`error:${scope}:${message}`),
    };

    const stream = new StepExecutionLogStream({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
    });

    stream.logger.log("worker", "starting step", { stepId: "abc" });
    stream.logger.error("health", "container unhealthy");
    await stream.shipper.flush();

    // Base sink still receives everything (CLI/file output preserved).
    expect(baseCalls).toEqual([
      "log:worker:starting step",
      "error:health:container unhealthy",
    ]);

    // Both lines were streamed as the worker stream, in order.
    const workerLines = sent.filter((line) => line.stream === "worker");
    expect(workerLines.map((line) => line.content)).toEqual([
      '[worker] starting step {"stepId":"abc"}',
      "ERROR [health] container unhealthy",
    ]);

    await stream.stop();
  });

  it("keeps debug worker logs local but out of the shipped feed", async () => {
    const sent: StepExecutionLogLine[] = [];
    const baseCalls: string[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: (scope, message) => baseCalls.push(`debug:${scope}:${message}`),
      log: (scope, message) => baseCalls.push(`log:${scope}:${message}`),
      error: (scope, message) => baseCalls.push(`error:${scope}:${message}`),
    };

    const stream = new StepExecutionLogStream({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
    });

    stream.logger.debug("heartbeat", "tick");
    stream.logger.log("worker", "started");
    await stream.shipper.flush();

    // Local sink sees both; the feed only sees the info-level line.
    expect(baseCalls).toEqual(["debug:heartbeat:tick", "log:worker:started"]);
    expect(sent.map((line) => line.content)).toEqual(["[worker] started"]);

    await stream.stop();
  });

  it("serializes Error details into the streamed line", async () => {
    const sent: StepExecutionLogLine[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: () => {},
      log: () => {},
      error: () => {},
    };

    const stream = new StepExecutionLogStream({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
    });

    stream.logger.error("worker", "boom", { error: new Error("kaboom") });
    await stream.shipper.flush();

    const line = sent.find((entry) => entry.content.includes("boom"));
    expect(line?.content).toContain("kaboom");
    await stream.stop();
  });

  it("attaches the opencode tail at most once without throwing", async () => {
    const sent: StepExecutionLogLine[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: () => {},
      log: () => {},
      error: () => {},
    };
    const stream = new StepExecutionLogStream({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
    });

    // No reachable container in unit context; spawn fails silently via onError.
    stream.attachOpencodeTail({
      runtimeContainerId: "missing-container",
      opencodeLogDirectory: "/nonexistent",
    });
    // Second call is a no-op.
    stream.attachOpencodeTail({
      runtimeContainerId: "missing-container",
      opencodeLogDirectory: "/nonexistent",
    });

    await stream.stop();
  });
});
