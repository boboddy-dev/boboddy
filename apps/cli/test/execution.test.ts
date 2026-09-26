import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import yargs from "yargs/yargs";
import type {
  InvestigateExecutionClient,
  LogLine,
  PipelineDefinition,
  PipelineExecution,
  StepExecution,
  WorkItem,
} from "@boboddy/platform-client";
import { concurrentTest, reporterLines } from "./utils";

const projectRoot = resolve(import.meta.dir, "..");
const cliEntrypoint = resolve(projectRoot, "src/index.ts");

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function run(
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): SpawnResult {
  const result = spawnSync(
    process.execPath,
    ["run", cliEntrypoint, ...args],
    {
      cwd: options?.cwd ?? projectRoot,
      env: { ...process.env, ...options?.env },
      encoding: "utf8",
    },
  );

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.status ?? 1,
  };
}

/**
 * `execution view --log`'s truncation/file-cache path (Phase 3 of
 * `docs/plans/execution-log-tail-truncation-and-file-cache.md`) is exercised
 * in-process rather than via `run()` above: faking the whole authenticated
 * HTTP+auth stack that `connectApi` sits on for a subprocess run is out of
 * proportion to what this phase owns (the real, disk-backed
 * `writeLogArtifact`). Instead, `../src/lib/cli-api-client` and
 * `../src/lib/execution-log-cache` are mocked (mirroring
 * `telemetry.test.ts`'s `mock.module` pattern, the only other precedent for
 * in-process module mocking in this package), while the real
 * `investigateExecution` (`@boboddy/platform-client`, unmocked) and the real
 * `createExecutionLogArtifactWriter` (`apps/cli`'s own module under test,
 * unmocked) still run — so this proves the actual wiring in
 * `commands/execution.ts` and the actual disk write, not a re-implementation
 * of either. Neither mocked module is imported by any other test file in
 * this package (verified via grep), so this cannot leak into unrelated
 * tests despite `mock.module`'s process-wide scope.
 */
const EXECUTION_ID = "01a0b53a-e335-735b-9600-ded80d3488d2";
const STEP_EXECUTION_ID = "step-exec-1";

let logCacheDir = "";
const recordedArtifactWrites: {
  stepExecutionId: string;
  requestedStream: string;
  fullText: string;
}[] = [];

// Captured into plain local bindings (not accessed through the module
// namespace object below) — `mock.module` retroactively patches the module
// registry entry itself, so a reference held via
// `realExecutionLogCache.createExecutionLogArtifactWriter` would resolve to
// the *mocked* function once registered, recursing infinitely.
const { createExecutionLogArtifactWriter: realCreateExecutionLogArtifactWriter } =
  await import("../src/lib/execution-log-cache");

void mock.module("../src/lib/execution-log-cache", () => ({
  createExecutionLogArtifactWriter: () => {
    const realWriter = realCreateExecutionLogArtifactWriter(logCacheDir);
    return async (input: {
      stepExecutionId: string;
      requestedStream: string;
      fullText: string;
    }) => {
      recordedArtifactWrites.push(input);
      return realWriter(
        input as Parameters<
          ReturnType<typeof realCreateExecutionLogArtifactWriter>
        >[0],
      );
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
            stepExecutionId: STEP_EXECUTION_ID,
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

  const stepExecution: StepExecution = {
    id: STEP_EXECUTION_ID,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
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
    stepExecutions: {
      getStepExecution: () =>
        Promise.resolve({ data: stepExecution, error: undefined }),
      readStepExecutionLogs: () =>
        Promise.resolve({
          data: { lines: logLines, nextOffset: logLines.length, complete: false },
          error: undefined,
        }),
      getStepExecutionLogArchive: () =>
        Promise.resolve({ data: { url: null, sizeBytes: 0 }, error: undefined }),
      listStepExecutionArtifacts: () =>
        Promise.resolve({ data: [], error: undefined }),
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

describe("boboddy execution", () => {
  describe("help output", () => {
    concurrentTest("execution --help lists the view subcommand", () => {
      const result = run(["execution", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("view <executionId>");
    });

    concurrentTest("top-level --help includes the execution command", () => {
      const result = run(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("execution <command>");
    });

    concurrentTest("execution view --help lists every flag", () => {
      const result = run(["execution", "view", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("executionId");
      expect(result.stdout).toContain("--attempt");
      expect(result.stdout).toContain("--step");
      expect(result.stdout).toContain("--log");
      expect(result.stdout).toContain("--log-stream");
      expect(result.stdout).toContain("--artifacts");
      expect(result.stdout).toContain("--base-url");
    });

    concurrentTest("rejects unknown options (strict mode)", () => {
      const result = run([
        "execution",
        "view",
        "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
        "--nope",
      ]);

      expect(result.exitCode).toBe(1);
    });
  });

  describe("execution view", () => {
    concurrentTest(
      "exits with error and helpful message when not signed in",
      () => {
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-execution-view-test-"),
        );
        try {
          const result = run(
            [
              "execution",
              "view",
              "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
            ],
            { env: { HOME: fakeHome } },
          );

          expect(result.exitCode).toBe(1);
          // The not-signed-in error surfaces on stderr via reporter.error, the
          // same as every other command that calls `connectApi`/
          // `loadAuthenticatedSession` (see pipelines.test.ts).
          expect(
            reporterLines(result.stderr).some((line) =>
              line.toLowerCase().includes("not signed in"),
            ),
          ).toBe(true);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
        }
      },
    );

    concurrentTest(
      "rejects an invalid --log-stream value before connecting",
      () => {
        const fakeHome = mkdtempSync(
          join(tmpdir(), "boboddy-execution-view-logstream-test-"),
        );
        try {
          const result = run(
            [
              "execution",
              "view",
              "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
              "--log-stream",
              "not-a-real-stream",
            ],
            { env: { HOME: fakeHome } },
          );

          expect(result.exitCode).toBe(1);
          expect(
            reporterLines(result.stderr).some((line) =>
              line.includes("Invalid --log-stream"),
            ),
          ).toBe(true);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
        }
      },
    );
  });

  describe("execution view --log truncation and file cache", () => {
    beforeEach(() => {
      logCacheDir = mkdtempSync(
        join(tmpdir(), "boboddy-execution-log-cache-test-"),
      );
      recordedArtifactWrites.length = 0;
      fakeInvestigateClient = null;
    });

    afterEach(() => {
      rmSync(logCacheDir, { recursive: true, force: true });
      fakeInvestigateClient = null;
    });

    test("writes the full untruncated log to disk and mentions its path on stdout when the render is truncated", async () => {
      const logLines = makeOversizedLogLines();
      fakeInvestigateClient = buildFakeInvestigateClient(logLines);

      const { stdout } = await runExecutionCommand([
        "execution",
        "view",
        EXECUTION_ID,
        "--log",
      ]);

      expect(recordedArtifactWrites).toHaveLength(1);
      expect(recordedArtifactWrites[0]?.stepExecutionId).toBe(
        STEP_EXECUTION_ID,
      );
      expect(recordedArtifactWrites[0]?.requestedStream).toBe("all");

      const pathMatch = /Full log saved to (.+?)\.]/.exec(stdout);
      expect(pathMatch).not.toBeNull();
      const writtenPath = pathMatch?.[1] ?? "";
      expect(writtenPath.startsWith(logCacheDir)).toBe(true);
      expect(writtenPath).toBe(
        join(logCacheDir, `${STEP_EXECUTION_ID}-all.log`),
      );

      const writtenContents = readFileSync(writtenPath, "utf8");
      const recordedFullText = recordedArtifactWrites[0]?.fullText;
      expect(recordedFullText).toBeDefined();
      expect(writtenContents).toBe(recordedFullText ?? "");
      // The full file keeps both the head and the tail; the capped stdout
      // preview (Phase 1) keeps only the tail — proving the file really is
      // the *un*truncated version, not a copy of what's already on stdout.
      expect(writtenContents).toContain("line number 0 ");
      expect(writtenContents).toContain("line number 1999 ");
      expect(stdout).not.toContain("line number 0 ");
      expect(stdout).toContain("line number 1999 ");
    });

    test("never writes a file when the rendered log fits under the cap", async () => {
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

      expect(recordedArtifactWrites).toHaveLength(0);
      expect(stdout).toContain("starting up");
      expect(stdout).not.toContain("Full log saved to");
    });
  });
});
