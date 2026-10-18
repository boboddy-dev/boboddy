import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs/yargs";
import type {
  ApiErrorBody,
  FullLogSaver,
  InvestigateExecutionClient,
  LogLine,
  PipelineDefinition,
  PipelineExecution,
  Task,
  WorkItem,
} from "@boboddy/platform-client";

/**
 * `execution view --log`'s full-log file is exercised in-process rather than
 * via a CLI subprocess (as `execution.test.ts` does): faking the whole authenticated HTTP+auth stack that
 * `connectApi` sits on for a subprocess run is out of proportion to what
 * these tests own (the real, disk-backed `saveFullLog`). Instead,
 * `../src/lib/cli-api-client` and `../src/lib/execution-log-cache` are mocked
 * (mirroring `telemetry.test.ts`'s `mock.module` pattern), while the real
 * `investigateExecution` (`@boboddy/platform-client`, unmocked) and the real
 * `createFullLogSaver` (only redirected to a temp dir) still run — so this
 * proves the actual wiring in `commands/execution.ts` and the actual disk
 * write. Neither mocked module is imported by any other test file in this
 * package, so this cannot leak into unrelated tests despite `mock.module`'s
 * process-wide scope.
 */
const EXECUTION_ID = "01a0b53a-e335-735b-9600-ded80d3488d2";
const TASK_ID = "step-exec-1";

let logCacheDir = "";
let failNextSave: Error | null = null;
const recordedSaves: Parameters<FullLogSaver>[0][] = [];

// Captured into a plain local binding (not accessed through the module
// namespace object) — `mock.module` retroactively patches the module registry
// entry itself, so a namespace reference would resolve to the *mocked*
// function once registered, recursing infinitely.
const { createFullLogSaver: realCreateFullLogSaver } =
  await import("../src/lib/execution-log-cache");

void mock.module("../src/lib/execution-log-cache", () => ({
  createFullLogSaver: (): FullLogSaver => {
    const realSaver = realCreateFullLogSaver(logCacheDir);
    return (input) => {
      recordedSaves.push(input);
      if (failNextSave !== null) return Promise.reject(failNextSave);
      return realSaver(input);
    };
  },
}));

let fakeInvestigateClient: InvestigateExecutionClient | null = null;
void mock.module("../src/lib/cli-api-client", () => ({
  connectApi: () => {
    if (fakeInvestigateClient === null) {
      throw new Error("fakeInvestigateClient not configured for this test");
    }
    return Promise.resolve({
      client: fakeInvestigateClient,
      headers: { Authorization: "Bearer test-token" },
    });
  },
  describeApiError: (error: { title?: string; detail?: string }) =>
    error.detail ?? error.title ?? "the server rejected the request",
}));

const { executionCommand } = await import("../src/commands/execution");

/** Log lines whose rendered form comfortably exceeds `MAX_LOG_RENDER_CHARS`
 * (20,000 chars), mirroring
 * `packages/platform-client/tests/investigate-execution.test.ts`'s own
 * `makeOversizedLogLines`. */
function makeOversizedLogLines(): LogLine[] {
  return Array.from({ length: 2_000 }, (_, index) => ({
    seq: index,
    stream: "worker" as const,
    ts: "2026-01-01T00:00:00.000Z",
    content: `line number ${String(index)} `.repeat(5),
    level: "info" as const,
  }));
}

/** A minimal, self-consistent fake `InvestigateExecutionClient` with a
 * single running step ("investigate", the attempt's `currentStepKey"), so
 * `--log` resolves that step without needing `--step` explicitly and takes
 * the live (not archive) log path. */
function buildFakeInvestigateClient(
  logLines: LogLine[],
  options: { archiveError?: ApiErrorBody } = {},
): InvestigateExecutionClient {
  const execution: PipelineExecution = {
    id: EXECUTION_ID,
    workItemId: "work-item-1",
    workItemTitle: "Fix the flaky test",
    pipelineDefinitionId: "pipeline-def-1",
    definitionStepCount: 1,
    status: "running",
    attempts: [
      {
        id: "attempt-1",
        attemptNumber: 1,
        currentStepKey: "investigate",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        status: "running",
        stepRuns: [
          {
            id: "step-run-1",
            stepKey: "investigate",
            position: 1,
            nodeKind: "step",
            branchIndex: null,
            status: "running",
            satisfactionStatus: "not_evaluated",
            taskId: TASK_ID,
            workBranch: "boboddy/investigate-1",
            outputJson: null,
            evaluation: null,
            acceptedByUserId: null,
            acceptedAt: null,
            acceptanceReason: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
  };

  const pipelineDefinition: PipelineDefinition = {
    id: "pipeline-def-1",
    key: "bug-triage",
    name: "Bug Triage",
    stepDefinitions: [
      {
        id: "step-def-1",
        key: "investigate",
        name: "Investigate",
        position: 1,
      },
    ],
  };

  const workItem: WorkItem = {
    id: "work-item-1",
    title: "Fix the flaky test",
    url: null,
  };

  const archiveError = options.archiveError;
  const task: Task = {
    id: TASK_ID,
    status: archiveError === undefined ? "running" : "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: archiveError === undefined ? null : "2026-01-01T00:05:00.000Z",
    result: null,
  };

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
          data: {
            lines: logLines,
            nextOffset: logLines.length,
            complete: false,
          },
          error: undefined,
        }),
      getTaskLogArchive: () =>
        Promise.resolve(
          archiveError === undefined
            ? { data: { url: null, sizeBytes: 0 }, error: undefined }
            : { data: undefined, error: archiveError },
        ),
      listTaskArtifacts: () => Promise.resolve({ data: [], error: undefined }),
      getArtifactDownloadUrl: () =>
        Promise.resolve({
          data: {
            url: null,
            sizeBytes: 0,
            contentType: null,
            relativeStorePath: "",
          },
          error: undefined,
        }),
    },
  };
}

/**
 * Invokes `executionCommand` in-process (not `src/index.ts`, whose top-level
 * `run()`/`process.exit()` would kill the test process on import), mirroring
 * `createCli`'s relevant yargs options (`index.ts:26-40`) so error handling
 * matches production, and capturing everything written to `process.stdout`.
 */
async function runExecutionCommand(
  args: readonly string[],
): Promise<{ stdout: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };

  try {
    await yargs(args)
      .command(executionCommand)
      .exitProcess(false)
      .showHelpOnFail(false)
      .fail((message, error) => {
        throw error instanceof Error ? error : new Error(message);
      })
      .parseAsync();
  } finally {
    process.stdout.write = originalWrite;
  }

  return { stdout: chunks.join("") };
}

describe("execution view --log full log file", () => {
  beforeEach(() => {
    logCacheDir = mkdtempSync(
      join(tmpdir(), "boboddy-execution-log-cache-test-"),
    );
    recordedSaves.length = 0;
    failNextSave = null;
    fakeInvestigateClient = null;
  });

  afterEach(() => {
    rmSync(logCacheDir, { recursive: true, force: true });
    fakeInvestigateClient = null;
    failNextSave = null;
  });

  function headerLine(stdout: string): string {
    return (
      stdout.split("\n").find((line) => line.startsWith("Logs for step")) ?? ""
    );
  }

  test("a short log still writes a file and names it on the header line", async () => {
    fakeInvestigateClient = buildFakeInvestigateClient([
      {
        seq: 0,
        stream: "worker",
        ts: "2026-01-01T00:00:00.000Z",
        content: "starting up",
        level: "info",
      },
    ]);

    const { stdout } = await runExecutionCommand([
      "execution",
      "view",
      EXECUTION_ID,
      "--log",
    ]);

    const expectedPath = join(logCacheDir, `${TASK_ID}-all.log`);
    expect(headerLine(stdout)).toBe(
      `Logs for step investigate (live snapshot, step still running) · full log: ${expectedPath}`,
    );
    expect(readFileSync(expectedPath, "utf8")).toContain("starting up");
    expect(stdout).toContain("starting up");
    expect(stdout).not.toContain("earlier characters omitted");
  });

  test("a long log writes the uncapped file and prints a capped tail with the note first", async () => {
    fakeInvestigateClient = buildFakeInvestigateClient(makeOversizedLogLines());

    const { stdout } = await runExecutionCommand([
      "execution",
      "view",
      EXECUTION_ID,
      "--log-stream",
      "worker",
    ]);

    const expectedPath = join(logCacheDir, `${TASK_ID}-worker.log`);
    expect(recordedSaves).toHaveLength(1);
    expect(recordedSaves[0]?.requestedStream).toBe("worker");
    const lines = stdout.split("\n");
    const headerIndex = lines.findIndex((line) =>
      line.startsWith("Logs for step"),
    );
    expect(lines[headerIndex]).toBe(
      `Logs for step investigate (live snapshot, step still running) · full log: ${expectedPath}`,
    );
    expect(lines[headerIndex + 2]).toMatch(
      /^… [\d,]+ earlier characters omitted \(see full log above\)$/,
    );

    const writtenContents = readFileSync(expectedPath, "utf8");
    expect(writtenContents).toBe(recordedSaves[0]?.fullText ?? "");
    expect(writtenContents).toContain("line number 0 ");
    expect(writtenContents).toContain("line number 1999 ");
    expect(stdout).not.toContain("line number 0 ");
    expect(stdout).toContain("line number 1999 ");
  });

  test("a failed write shows not saved on the header line", async () => {
    fakeInvestigateClient = buildFakeInvestigateClient([
      {
        seq: 0,
        stream: "worker",
        ts: "2026-01-01T00:00:00.000Z",
        content: "starting up",
        level: "info",
      },
    ]);
    failNextSave = new Error("EACCES: permission denied");

    const { stdout } = await runExecutionCommand([
      "execution",
      "view",
      EXECUTION_ID,
      "--log",
    ]);

    expect(headerLine(stdout)).toBe(
      "Logs for step investigate (live snapshot, step still running) · full log: not saved (EACCES: permission denied)",
    );
    expect(stdout).toContain("starting up");
    expect(existsSync(join(logCacheDir, `${TASK_ID}-all.log`))).toBe(false);
  });

  test("a 402 on the log archive prints the quota message and writes no file", async () => {
    fakeInvestigateClient = buildFakeInvestigateClient([], {
      archiveError: {
        status: 402,
        title: "Payment Required",
        detail: "USAGE_LIMIT_EXCEEDED_READ",
      },
    });

    const { stdout } = await runExecutionCommand([
      "execution",
      "view",
      EXECUTION_ID,
      "--log",
    ]);

    expect(stdout).toContain(
      "Logs for step investigate: log archive read quota exceeded",
    );
    expect(stdout).not.toContain("full log:");
    expect(recordedSaves).toHaveLength(0);
    expect(readdirSync(logCacheDir)).toHaveLength(0);
  });
});
