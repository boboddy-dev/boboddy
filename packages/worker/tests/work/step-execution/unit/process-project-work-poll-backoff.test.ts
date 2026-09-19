/**
 * Locks in the claim-poll idle backoff added to `process-project-work.ts`'s
 * `runPollingLoop`: consecutive empty claim polls double the wait up to
 * `maxPollIntervalMs`, and a poll that claims anything resets straight back
 * to `pollIntervalMs`. See the Vercel Fluid Active CPU / Neon compute-hours
 * usage writeup this closed — the prior fixed 5s cadence never let the DB
 * autosuspend even when there was no work queued.
 */
import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { processProjectWork } from "../../../../src/work/step-execution/application/process-project-work";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StepExecutionWorkerClaim,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";
import {
  createRunTracker,
  createWorkerClient,
} from "./helpers/claimed-step-execution-fixtures";

const projectId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe005");
const stepExecutionId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe006");

const claim: StepExecutionWorkerClaim = {
  stepExecution: { id: stepExecutionId },
  claimToken: "claim-token",
};

// Stops the polling loop deterministically instead of relying on `once`
// (which only runs a single iteration — too few to observe backoff growth).
class StopPolling extends Error {}

function buildDeps(
  claimStepExecutions: ProcessProjectWorkDeps["workerClient"]["claimStepExecutions"],
  sleepCalls: number[],
) {
  const workerClient = createWorkerClient();
  return {
    workerClient: {
      ...workerClient,
      claimStepExecutions,
      // The one claimed job fails fast (launch rejects below) and reports
      // itself failed in the background; these just need to resolve so that
      // background cleanup doesn't throw an unhandled rejection.
      getStepExecution: vi.fn(() =>
        Promise.resolve({ status: "running" as const }),
      ),
      failStepExecution: vi.fn(() => Promise.resolve(undefined)),
    },
    createRunTracker,
    runtimeEnvironmentOrchestrator: {
      launch: vi.fn(() => Promise.reject(new Error("launch not used"))),
    },
    agentRunner: {
      promptAsync: vi.fn(() => Promise.reject(new Error("not used"))),
      getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
      sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
    },
    artifactStore: {
      saveArtifact: vi.fn(),
    },
    sleep: (milliseconds: number) => {
      sleepCalls.push(milliseconds);
      return Promise.resolve(undefined);
    },
    logger: {
      debug: vi.fn(),
      log: vi.fn(),
      error: vi.fn(),
    },
  } satisfies ProcessProjectWorkDeps;
}

describe("claim-poll idle backoff", () => {
  test("doubles the wait on empty polls, caps at maxPollIntervalMs, and resets on a claim", async () => {
    let call = 0;
    const claimStepExecutions = vi.fn(() => {
      call += 1;
      if (call <= 3) {
        return Promise.resolve([]);
      }
      if (call === 4) {
        return Promise.resolve([claim]);
      }
      return Promise.reject(new StopPolling());
    });
    const sleepCalls: number[] = [];
    const deps = buildDeps(claimStepExecutions, sleepCalls);

    const input: ProcessProjectWorkInput = {
      projectId,
      workerId: "worker-1",
      // Headroom so the one claimed (fast-failing) job never blocks the next
      // poll regardless of exactly when its background cleanup settles.
      batchSize: 3,
      concurrency: 3,
      pollIntervalMs: 100,
      maxPollIntervalMs: 500,
      leaseDurationSeconds: 30,
    };

    try {
      await processProjectWork(input, deps);
      throw new Error("expected processProjectWork to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(StopPolling);
    }

    expect(sleepCalls).toEqual([
      200, // 100 -> 200 (first empty poll)
      400, // 200 -> 400 (second empty poll)
      500, // 400 -> 800, capped at maxPollIntervalMs
      100, // reset to pollIntervalMs: the 4th poll claimed the step
    ]);
  });

  test("never backs off when maxPollIntervalMs is omitted (matches prior fixed-cadence behavior)", async () => {
    let call = 0;
    const claimStepExecutions = vi.fn(() => {
      call += 1;
      if (call <= 3) {
        return Promise.resolve([]);
      }
      return Promise.reject(new StopPolling());
    });
    const sleepCalls: number[] = [];
    const deps = buildDeps(claimStepExecutions, sleepCalls);

    const input: ProcessProjectWorkInput = {
      projectId,
      workerId: "worker-1",
      batchSize: 1,
      concurrency: 1,
      pollIntervalMs: 100,
      leaseDurationSeconds: 30,
    };

    try {
      await processProjectWork(input, deps);
      throw new Error("expected processProjectWork to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(StopPolling);
    }

    expect(sleepCalls).toEqual([100, 100, 100]);
  });
});
