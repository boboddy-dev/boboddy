import { describe, expect, it, vi } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { StepExecutionLogShipper } from "../../../../src/work/step-execution/application/step-execution-log-shipper";
import type { StepExecutionLogLine } from "../../../../src/work/step-execution/contracts/process-project-work-types";

const buildShipper = (
  append: (input: {
    stepExecutionId: ReturnType<typeof createUuidV7>;
    claimToken: string;
    lines: StepExecutionLogLine[];
  }) => Promise<{ nextOffset: number }>,
  // eslint-disable-next-line local/no-unknown-parameter-type
  onError?: (error: unknown) => void,
) =>
  new StepExecutionLogShipper({
    workerClient: { appendStepExecutionLogs: append },
    stepExecutionId: createUuidV7(),
    claimToken: "claim-token",
    ...(onError ? { onError } : {}),
  });

describe("StepExecutionLogShipper", () => {
  it("assigns monotonic seq across streams and ships in order", async () => {
    const sent: StepExecutionLogLine[] = [];
    const shipper = buildShipper((input) => {
      sent.push(...input.lines);
      return Promise.resolve({ nextOffset: input.lines.at(-1)?.seq ?? 0 });
    });

    shipper.enqueue("worker", "first");
    shipper.enqueue("ai-server", "second");
    shipper.enqueue("worker", "third");
    await shipper.flush();

    expect(sent.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(sent.map((l) => l.stream)).toEqual(["worker", "ai-server", "worker"]);
    expect(sent.map((l) => l.content)).toEqual(["first", "second", "third"]);
  });

  it("retains unsent lines and reports the error when shipping fails", async () => {
    const onError = vi.fn();
    let calls = 0;
    const shipper = buildShipper((input) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ nextOffset: input.lines.at(-1)?.seq ?? 0 });
    }, onError);

    shipper.enqueue("worker", "line");
    await shipper.flush();
    expect(onError).toHaveBeenCalledTimes(1);

    // Second flush retries the retained line successfully.
    const sent: StepExecutionLogLine[] = [];
    const retryShipper = buildShipper((input) => {
      sent.push(...input.lines);
      return Promise.resolve({ nextOffset: 0 });
    });
    retryShipper.enqueue("worker", "retry-line");
    await retryShipper.flush();
    expect(sent).toHaveLength(1);
  });

  it("flushes remaining lines on stop", async () => {
    const sent: StepExecutionLogLine[] = [];
    const shipper = buildShipper((input) => {
      sent.push(...input.lines);
      return Promise.resolve({ nextOffset: 0 });
    });
    shipper.start();
    shipper.enqueue("worker", "before-stop");
    await shipper.stop();
    expect(sent.map((l) => l.content)).toEqual(["before-stop"]);
  });

  it("drops diagnostic lines below the minimum ship level", async () => {
    const sent: StepExecutionLogLine[] = [];
    const shipper = new StepExecutionLogShipper({
      workerClient: {
        appendStepExecutionLogs: (input) => {
          sent.push(...input.lines);
          return Promise.resolve({ nextOffset: 0 });
        },
      },
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
      minShipLevel: "info",
    });

    shipper.enqueue("worker", "tick", undefined, "debug"); // dropped
    shipper.enqueue("ai-server", "verbose", undefined, "debug"); // dropped
    shipper.enqueue("worker", "started", undefined, "info"); // kept
    shipper.enqueue("ai-server", "boom", undefined, "error"); // kept
    await shipper.flush();

    expect(sent.map((l) => l.content)).toEqual(["started", "boom"]);
  });

  it("always ships conversation lines regardless of ship level", async () => {
    const sent: StepExecutionLogLine[] = [];
    const shipper = new StepExecutionLogShipper({
      workerClient: {
        appendStepExecutionLogs: (input) => {
          sent.push(...input.lines);
          return Promise.resolve({ nextOffset: 0 });
        },
      },
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
      minShipLevel: "error",
    });

    // Even with the highest threshold, product-data conversation lines ship.
    shipper.enqueue("conversation", '{"kind":"text"}', undefined, "debug");
    shipper.enqueue("worker", "info-line", undefined, "info"); // dropped
    await shipper.flush();

    expect(sent.map((l) => l.stream)).toEqual(["conversation"]);
  });

  it("drops the oldest lines under buffer backpressure", async () => {
    const sent: StepExecutionLogLine[] = [];
    const shipper = new StepExecutionLogShipper({
      workerClient: {
        appendStepExecutionLogs: (input) => {
          sent.push(...input.lines);
          return Promise.resolve({ nextOffset: 0 });
        },
      },
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
      maxBufferLines: 2,
      maxBatchLines: 10,
    });
    shipper.enqueue("worker", "a");
    shipper.enqueue("worker", "b");
    shipper.enqueue("worker", "c");
    await shipper.flush();
    expect(sent.map((l) => l.content)).toEqual(["b", "c"]);
  });
});
