import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { monitorStartedClaimedTask } from "../../../../src/work/task/application/process-project-work-monitor";
import type { ProcessProjectWorkInput } from "../../../../src/work/task/contracts/process-project-work-types";
import {
  createDeps,
  createInput,
  createStartedTask,
  createTracker,
  stopStub,
} from "./helpers/process-project-work-monitor-artifacts-fixtures";

async function runUntilMissingFindingsFailure(
  overrides: Partial<ProcessProjectWorkInput>,
) {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "boboddy-monitor-grace-"),
  );
  const startedTask = createStartedTask(workspacePath);
  const input = { ...createInput(startedTask), ...overrides };
  let statusCall = 0;
  const deps = createDeps({
    callOrder: [],
    saveArtifact: vi.fn(),
    completeTask: vi.fn(),
    finalStepStatus: "running",
    getSessionStatus: vi.fn(() => {
      statusCall += 1;
      return Promise.resolve({ running: statusCall === 1 });
    }),
  });
  const sleeps: number[] = [];
  let sleepsBeforeRetry = -1;
  deps.sleep = vi.fn((milliseconds: number) => {
    sleeps.push(milliseconds);
    return Promise.resolve(undefined);
  });
  deps.agentRunner.sendRetryPrompt = vi.fn(() => {
    sleepsBeforeRetry = sleeps.length;
    return Promise.resolve(undefined);
  });

  let caught: unknown;
  try {
    await monitorStartedClaimedTask(
      input,
      deps,
      createTracker(),
      startedTask,
      stopStub(),
      { flush: vi.fn(() => Promise.resolve()) },
    );
  } catch (error) {
    caught = error;
  }
  expect((caught as Error).message).toMatch(
    /without findings submission via boboddy-submit-step-findings/u,
  );

  return { sleeps, sleepsBeforeRetry };
}

describe("monitorStartedClaimedTask missing-findings grace window", () => {
  test.concurrent(
    "each window lasts missingFindingsGraceMs, not one poll",
    async () => {
      const { sleeps, sleepsBeforeRetry } =
        await runUntilMissingFindingsFailure({
          pollIntervalMs: 10,
          missingFindingsGraceMs: 50,
        });

      expect(sleepsBeforeRetry).toBe(1 + 5);
      expect(sleeps).toEqual(Array.from({ length: 1 + 3 * 5 }, () => 10));
    },
  );

  test.concurrent(
    "a window that is not a multiple of the poll interval rounds up to whole polls",
    async () => {
      const { sleeps, sleepsBeforeRetry } =
        await runUntilMissingFindingsFailure({
          pollIntervalMs: 20,
          missingFindingsGraceMs: 50,
        });

      expect(sleepsBeforeRetry).toBe(1 + 3);
      expect(sleeps).toHaveLength(1 + 3 * 3);
    },
  );

  test.concurrent(
    "defaults to one poll per window when missingFindingsGraceMs is unset",
    async () => {
      const { sleeps, sleepsBeforeRetry } =
        await runUntilMissingFindingsFailure({ pollIntervalMs: 5_000 });

      expect(sleepsBeforeRetry).toBe(2);
      expect(sleeps).toEqual([5_000, 5_000, 5_000, 5_000]);
    },
  );
});
