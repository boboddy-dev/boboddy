import { describe, expect, it, vi } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { SecretMasker } from "../../../../src/work/step-execution/application/secret-masker";
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
    secretMasker: new SecretMasker(),
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
    shipper.enqueue("ai-server", "second", undefined, "error");
    shipper.enqueue("worker", "third", undefined, "warn");
    await shipper.flush();

    expect(sent.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(sent.map((l) => l.stream)).toEqual(["worker", "ai-server", "worker"]);
    expect(sent.map((l) => l.content)).toEqual(["first", "second", "third"]);
    // The source-assigned level is carried through to the shipped line
    // (defaulting to `info`) rather than being dropped.
    expect(sent.map((l) => l.level)).toEqual(["info", "error", "warn"]);
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
      secretMasker: new SecretMasker(),
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
      secretMasker: new SecretMasker(),
      minShipLevel: "error",
    });

    // Even with the highest threshold, product-data conversation lines ship.
    shipper.enqueue("conversation", '{"kind":"text"}', undefined, "debug");
    shipper.enqueue("worker", "info-line", undefined, "info"); // dropped
    await shipper.flush();

    expect(sent.map((l) => l.stream)).toEqual(["conversation"]);
  });

  it("strips NUL and C0 control characters that Postgres text rejects", async () => {
    // Raw devcontainer/AWS-CLI output contains NUL bytes and ANSI/terminal
    // control sequences. Postgres `text` rejects NUL with "invalid byte
    // sequence for encoding UTF8: 0x00", which aborts the whole batch INSERT
    // and permanently stalls the feed. The shipper must sanitize at enqueue.
    const sent: StepExecutionLogLine[] = [];
    const shipper = buildShipper((input) => {
      sent.push(...input.lines);
      return Promise.resolve({ nextOffset: 0 });
    });

    shipper.enqueue(
      "worker",
      "docker\u0000 run\u0007 \u001b[31mred\u001b[0m\ttab\nnewline\rcr",
    );
    await shipper.flush();

    const content = sent[0]?.content ?? "";
    expect(content).not.toContain("\u0000"); // NUL removed
    expect(content).not.toContain("\u0007"); // BEL removed
    expect(content).not.toContain("\u001b"); // ESC removed
    // Meaningful whitespace is preserved.
    expect(content).toContain("\t");
    expect(content).toContain("\n");
    expect(content).toContain("\r");
    expect(content).toBe("docker run [31mred[0m\ttab\nnewline\rcr");
  });

  it("replaces lone UTF-16 surrogates that cannot encode as UTF-8", async () => {
    const sent: StepExecutionLogLine[] = [];
    const shipper = buildShipper((input) => {
      sent.push(...input.lines);
      return Promise.resolve({ nextOffset: 0 });
    });

    shipper.enqueue("worker", "before\uD800after");
    await shipper.flush();

    expect(sent[0]?.content).toBe("before\uFFFDafter");
  });

  it("masks registered secret values before shipping", async () => {
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
      secretMasker: new SecretMasker(["supersecret"]),
    });

    shipper.enqueue("ai-server", "AWS_TOKEN=supersecret exported");
    await shipper.flush();

    expect(sent[0]?.content).toBe("AWS_TOKEN=*** exported");
  });

  it("masks the conversation stream too (which bypasses the level filter)", async () => {
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
      secretMasker: new SecretMasker(["leaked-token"]),
      minShipLevel: "error",
    });

    shipper.enqueue(
      "conversation",
      '{"text":"here is leaked-token"}',
      undefined,
      "debug",
    );
    await shipper.flush();

    expect(sent[0]?.content).toBe('{"text":"here is ***"}');
  });

  it("masks before applying the per-line length cap", async () => {
    const sent: StepExecutionLogLine[] = [];
    const secret = "s".repeat(50);
    const shipper = new StepExecutionLogShipper({
      workerClient: {
        appendStepExecutionLogs: (input) => {
          sent.push(...input.lines);
          return Promise.resolve({ nextOffset: 0 });
        },
      },
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
      secretMasker: new SecretMasker([secret]),
    });

    // The secret is masked first, so it cannot survive by straddling the cut.
    shipper.enqueue("worker", `prefix ${secret} suffix`);
    await shipper.flush();

    expect(sent[0]?.content).toBe("prefix *** suffix");
    expect(sent[0]?.content).not.toContain(secret);
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
      secretMasker: new SecretMasker(),
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
