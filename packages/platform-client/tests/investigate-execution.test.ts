import { describe, expect, test } from "bun:test";
import { investigateExecution } from "../src/investigate-execution";
import type {
  FullLogSaver,
  InvestigateExecutionClient,
} from "../src/lib/investigate-execution-client";
import type { ApiErrorBody, LogLine } from "../src/lib/api-types";
import {
  makeArtifact,
  makeArtifactDownloadUrl,
  makeAttempt,
  makeExecution,
  makePipelineDefinition,
  makeTask,
  makeWorkItem,
} from "./fixtures";

const headers = { Authorization: "Bearer test-token" };

/**
 * A fully-populated fake `InvestigateExecutionClient`: every method resolves
 * to a sensible happy-path default built from the shared fixtures. Tests
 * override individual methods by spreading over the relevant namespace.
 */
function buildFakeClient(): InvestigateExecutionClient {
  const execution = makeExecution();
  const pipelineDefinition = makePipelineDefinition();
  const workItem = makeWorkItem();
  // Live (not-yet-completed) by default, so tests that don't care about logs
  // never accidentally hit the archive path (which calls real `fetch`).
  const task = makeTask({ completedAt: null });

  return {
    pipelineExecutions: {
      getPipelineExecution: () =>
        Promise.resolve({ data: execution, error: undefined }),
    },
    pipelineDefinitions: {
      getPipelineDefinition: () =>
        Promise.resolve({ data: pipelineDefinition, error: undefined }),
    },
    workItems: {
      getWorkItem: () => Promise.resolve({ data: workItem, error: undefined }),
    },
    tasks: {
      getTask: () => Promise.resolve({ data: task, error: undefined }),
      readTaskLogs: () =>
        Promise.resolve({
          data: { lines: [], nextOffset: 0, complete: false },
          error: undefined,
        }),
      getTaskLogArchive: () =>
        Promise.resolve({
          data: { url: null, sizeBytes: 0 },
          error: undefined,
        }),
      listTaskArtifacts: () => Promise.resolve({ data: [], error: undefined }),
      getArtifactDownloadUrl: () =>
        Promise.resolve({ data: makeArtifactDownloadUrl(), error: undefined }),
    },
  };
}

function errorResult(error: ApiErrorBody): {
  data: undefined;
  error: ApiErrorBody;
} {
  return { data: undefined, error };
}

/** Lines whose rendered form comfortably exceeds `MAX_LOG_RENDER_CHARS`
 * (20,000 chars), to exercise the capped preview. */
function makeOversizedLogLines(): LogLine[] {
  return Array.from({ length: 2_000 }, (_, index) => ({
    seq: index,
    stream: "worker" as const,
    ts: "2026-01-01T00:00:00.000Z",
    content: `line number ${String(index)} `.repeat(5),
    level: "info" as const,
  }));
}

describe("investigateExecution", () => {
  test("happy path: no flags returns the execution summary", async () => {
    const client = buildFakeClient();

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
    });

    expect(output).toContain("Pipeline execution");
    expect(output).toContain("Steps:");
  });

  test("happy path: --step returns step detail", async () => {
    const client = buildFakeClient();

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
    });

    expect(output).toContain("Step: investigate");
    expect(output).toContain("Status: ✓ satisfied");
  });

  test("happy path: --log fetches the live feed for a running step", async () => {
    const client = buildFakeClient();
    client.tasks.readTaskLogs = () =>
      Promise.resolve({
        data: {
          lines: [
            {
              seq: 0,
              stream: "worker",
              ts: "2026-01-01T00:00:00.000Z",
              content: "starting up",
              level: "info",
            },
          ],
          nextOffset: 1,
          complete: false,
        },
        error: undefined,
      });

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      log: true,
    });

    expect(output).toContain("Step: investigate");
    expect(output).toContain("(live snapshot, step still running)");
    expect(output).toContain("starting up");
  });

  test("happy path: --artifacts lists artifacts with download URLs", async () => {
    const client = buildFakeClient();
    client.tasks.listTaskArtifacts = () =>
      Promise.resolve({ data: [makeArtifact()], error: undefined });

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      artifacts: true,
    });

    expect(output).toContain("Artifacts for step investigate:");
    expect(output).toContain("trace.zip");
  });

  test("attempt not found: throws a clear error naming the available attempts", () => {
    const client = buildFakeClient();

    expect(
      investigateExecution({
        client,
        headers,
        executionId: makeExecution().id,
        attempt: 99,
      }),
    ).rejects.toThrow(/Attempt 99 not found.*Available attempts: 1/);
  });

  test("step not found: throws a clear error naming the known steps", () => {
    const client = buildFakeClient();

    expect(
      investigateExecution({
        client,
        headers,
        executionId: makeExecution().id,
        step: "does-not-exist",
      }),
    ).rejects.toThrow(
      /Step "does-not-exist" not found.*Known steps: investigate/,
    );
  });

  test("execution not found (404): throws a distinct not-found error", () => {
    const client = buildFakeClient();
    client.pipelineExecutions.getPipelineExecution = () =>
      Promise.resolve(errorResult({ status: 404, title: "Not Found" }));

    expect(
      investigateExecution({
        client,
        headers,
        executionId: "missing-id",
      }),
    ).rejects.toThrow(/Pipeline execution missing-id not found/);
  });

  test("log archive metered (402): surfaces a distinct quota message, not a generic failure", async () => {
    const client = buildFakeClient();
    // Terminal task so investigateExecution takes the archive path.
    client.tasks.getTask = () =>
      Promise.resolve({
        data: makeTask({ completedAt: "2026-01-01T00:05:00.000Z" }),
        error: undefined,
      });
    client.tasks.getTaskLogArchive = () =>
      Promise.resolve(
        errorResult({
          status: 402,
          title: "Payment Required",
          detail: "USAGE_LIMIT_EXCEEDED_READ",
        }),
      );

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      log: true,
    });

    expect(output).toContain("log archive read quota exceeded");
    // The distinct 402 message, not a generic "could not load" failure.
    expect(output).not.toContain("could not load log archive");
  });

  test("log archive metered (402): saves no full log", async () => {
    const client = buildFakeClient();
    client.tasks.getTask = () =>
      Promise.resolve({
        data: makeTask({ completedAt: "2026-01-01T00:05:00.000Z" }),
        error: undefined,
      });
    client.tasks.getTaskLogArchive = () =>
      Promise.resolve(
        errorResult({
          status: 402,
          title: "Payment Required",
          detail: "USAGE_LIMIT_EXCEEDED_READ",
        }),
      );
    let calledCount = 0;
    const saveFullLog: FullLogSaver = () => {
      calledCount++;
      return Promise.resolve("/tmp/should-not-be-used.log");
    };

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      log: true,
      saveFullLog,
    });

    expect(calledCount).toBe(0);
    expect(output).toContain(
      "Logs for step investigate: log archive read quota exceeded",
    );
    expect(output).not.toContain("full log:");
  });

  test("artifact expired (410): reports that one artifact expired without failing the rest", async () => {
    const client = buildFakeClient();
    const expiring = makeArtifact({
      id: "artifact-expired",
      relativeStorePath: "old.log",
    });
    const healthy = makeArtifact({
      id: "artifact-healthy",
      relativeStorePath: "fresh.log",
    });
    client.tasks.listTaskArtifacts = () =>
      Promise.resolve({ data: [expiring, healthy], error: undefined });
    client.tasks.getArtifactDownloadUrl = (options) => {
      if (options.path.artifactId === "artifact-expired") {
        return Promise.resolve(errorResult({ status: 410, title: "Gone" }));
      }
      return Promise.resolve({
        data: makeArtifactDownloadUrl({ relativeStorePath: "fresh.log" }),
        error: undefined,
      });
    };

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      artifacts: true,
    });

    expect(output).toContain("old.log");
    expect(output).toContain("(unavailable: expired)");
    expect(output).toContain("fresh.log");
    expect(output).toContain("https://storage.example.test/trace.zip");
  });

  test("no step to show logs for: attempt has not started any steps", () => {
    const client = buildFakeClient();
    client.pipelineExecutions.getPipelineExecution = () =>
      Promise.resolve({
        data: makeExecution({
          attempts: [makeAttempt({ currentStepKey: null, stepRuns: [] })],
        }),
        error: undefined,
      });

    expect(
      investigateExecution({
        client,
        headers,
        executionId: makeExecution().id,
        log: true,
      }),
    ).rejects.toThrow(/has not started any steps yet/);
  });

  test("--log without --step defaults to the attempt's current step", async () => {
    const client = buildFakeClient();

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      log: true,
    });

    expect(output).toContain("Showing --log/--artifacts for step investigate");
  });

  test("--log saves the full log and names it on the header line, even when short", async () => {
    const client = buildFakeClient();
    client.tasks.readTaskLogs = () =>
      Promise.resolve({
        data: {
          lines: [
            {
              seq: 0,
              stream: "worker",
              ts: "2026-01-01T00:00:00.000Z",
              content: "starting up",
              level: "info",
            },
          ],
          nextOffset: 1,
          complete: false,
        },
        error: undefined,
      });

    const calls: Parameters<FullLogSaver>[0][] = [];
    const saveFullLog: FullLogSaver = (input) => {
      calls.push(input);
      return Promise.resolve("/tmp/example-task-all.log");
    };

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      log: true,
      saveFullLog,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.taskId).toBe("step-exec-1");
    expect(calls[0]?.requestedStream).toBe("all");
    expect(calls[0]?.fullText).toContain("starting up");
    expect(output).toContain(
      "Logs for step investigate (live snapshot, step still running) · full log: /tmp/example-task-all.log\n",
    );
    expect(output).not.toContain("earlier characters omitted");
  });

  test("--log saves the uncapped text and caps the preview when the log is long", async () => {
    const client = buildFakeClient();
    client.tasks.readTaskLogs = () =>
      Promise.resolve({
        data: {
          lines: makeOversizedLogLines(),
          nextOffset: 2_000,
          complete: false,
        },
        error: undefined,
      });

    const calls: Parameters<FullLogSaver>[0][] = [];
    const saveFullLog: FullLogSaver = (input) => {
      calls.push(input);
      return Promise.resolve("/tmp/example-task-all.log");
    };

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      log: true,
      saveFullLog,
    });

    expect(calls[0]?.fullText).toContain("line number 0 ");
    expect(calls[0]?.fullText).toContain("line number 1999");
    const logSection = output.slice(output.indexOf("Logs for step"));
    const [header, blank, note] = logSection.split("\n");
    expect(header).toBe(
      "Logs for step investigate (live snapshot, step still running) · full log: /tmp/example-task-all.log",
    );
    expect(blank).toBe("");
    expect(note).toMatch(
      /^… [\d,]+ earlier characters omitted \(see full log above\)$/,
    );
    expect(output).not.toContain("line number 0 ");
    expect(output).toContain("line number 1999");
  });

  test("--log names the reason on the header line when the full log can't be saved", async () => {
    const client = buildFakeClient();
    client.tasks.readTaskLogs = () =>
      Promise.resolve({
        data: {
          lines: makeOversizedLogLines(),
          nextOffset: 2_000,
          complete: false,
        },
        error: undefined,
      });

    const saveFullLog: FullLogSaver = () =>
      Promise.reject(new Error("disk full"));

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      log: true,
      saveFullLog,
    });

    expect(output).toContain(
      "Logs for step investigate (live snapshot, step still running) · full log: not saved (disk full)\n",
    );
    expect(output).toContain("earlier characters omitted");
  });
});
