import { describe, expect } from "bun:test";
import {
  formatHealthFinding,
  HEALTH_DRY_RUN_FAILED_MESSAGE,
  RUN_LATER_PREFIX,
  runDesignRunOffer,
} from "../src/lib/design-run-offer";
import {
  createPorts,
  finding,
  HEALTHY,
  PIPELINE_ID,
  RUN_COMMAND,
  TARGET,
} from "./design-run-offer-fixtures";
import {
  concurrentTest as test,
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
} from "./utils";

/**
 * The health-check gate in front of the run offer: every step's checks run
 * before the user is asked, a required failure blocks the offer, and each
 * failure is reported against the step that declared it.
 */

describe("runDesignRunOffer health-check gate", () => {
  test("passes the assigned pipeline id to the health-check dry run", async () => {
    const { reporter } = createRecorder();
    let checked: string | undefined;
    const { ports } = createPorts({
      runPipelineHealthDryRun: (pipelineDefinitionId) => {
        checked = pipelineDefinitionId;
        return Promise.resolve(HEALTHY);
      },
    });

    await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(checked).toBe(PIPELINE_ID);
  });

  test("blocks the run and names each failing step when a required check fails", async () => {
    const { reporter, calls: reported } = createRecorder();
    const testRunner = finding({
      stepName: "Failing Test",
      passed: false,
      message: "[nonzero-exit] vitest: not found",
      blocking: true,
    });
    const launch = finding({
      stepName: "Fix",
      checkName: "environment",
      passed: false,
      message: "project devcontainer failed to launch: exit 1",
      blocking: true,
    });
    const { ports, calls } = createPorts({
      runPipelineHealthDryRun: () =>
        Promise.resolve({
          ok: false,
          summary: "failing",
          findings: [finding({ stepName: "Investigate" }), testRunner, launch],
        }),
    });

    const result = await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(result.ran).toBe(false);
    // Blocking: nothing is queued and the user is never even asked.
    expect(calls.confirmRun).toBe(0);
    expect(calls.queueRun).toBe(0);
    expect(calls.runWorker).toBe(0);
    expect(reported).toContainEqual({
      method: "warn",
      message: HEALTH_DRY_RUN_FAILED_MESSAGE,
    });
    // One line per failing check, naming its step; passing checks stay quiet.
    expect(reported).toContainEqual({
      method: "error",
      message:
        "Failing Test › test-runner (required): [nonzero-exit] vitest: not found",
    });
    expect(reported).toContainEqual({
      method: "error",
      message: formatHealthFinding(launch),
    });
    expect(
      messages(reported).some((line) => line.startsWith("Investigate")),
    ).toBe(false);
    expect(messages(reported)).toContain(`${RUN_LATER_PREFIX} ${RUN_COMMAND}`);
  });

  test("shows a failed warn check but still offers the run", async () => {
    const { reporter, calls: reported } = createRecorder();
    const warned = finding({
      stepName: "Investigate And Reproduce",
      checkName: "playwright-cli",
      severity: "warn",
      passed: false,
      message: "[nonzero-exit] not installed",
    });
    const { ports, calls } = createPorts({
      runPipelineHealthDryRun: () =>
        Promise.resolve({ ok: true, summary: "healthy", findings: [warned] }),
    });

    const result = await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(result.ran).toBe(true);
    expect(calls.confirmRun).toBe(1);
    expect(reported).toContainEqual({
      method: "warn",
      message: formatHealthFinding(warned),
    });
    expect(messages(reported)).not.toContain(HEALTH_DRY_RUN_FAILED_MESSAGE);
  });

  test("runs the health checks only after a pipeline is known to be assigned", async () => {
    const { reporter } = createRecorder();
    const { ports, calls } = createPorts({
      resolveAssignedPipeline: () => Promise.resolve(undefined),
    });

    await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    // No pipeline id to check against, so there is nothing to dry-run yet.
    expect(calls.runPipelineHealthDryRun).toBe(0);
  });
});
