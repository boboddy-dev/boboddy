import { describe, expect } from "bun:test";
import {
  DEVCONTAINER_MISSING_MESSAGE,
  FIRST_STEP_DRY_RUN_FAILED_MESSAGE,
  formatRunCommand,
  NO_PIPELINE_MESSAGE,
  NOTHING_QUEUED_MESSAGE,
  RUN_LATER_PREFIX,
  RUN_LAUNCH_MESSAGE,
  RUN_REPAIR_GUIDANCE,
  runDesignRunOffer,
  type DesignRunOfferPorts,
  type DesignRunTarget,
} from "../src/lib/design-run-offer";
import {
  concurrentTest as test,
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
} from "./utils";

/**
 * The tail of `boboddy pipelines design`: the offer to run the pipeline the
 * session just built, on the work item the session was about.
 *
 * Worth testing without a terminal because every branch here is a decision the
 * user feels — whether they are asked at all, whether anything is queued when
 * they decline, and whether a failure sends them somewhere useful. The ordering
 * assertions matter as much as the outcomes: a run must be queued before the
 * worker looks for it, and the reporter block must be closed before the worker
 * takes over the terminal.
 */

const TARGET: DesignRunTarget = {
  projectId: "019ed1b9-c02d-7170-a08a-1ff912085f7b",
  workItemId: "019ed1c0-1111-7170-a08a-1ff912085f7b",
  workItemTitle: "Checkout button does nothing on mobile Safari",
};

const PIPELINE_ID = "019ed1c9-2222-7170-a08a-1ff912085f7b";

const RUN_COMMAND = formatRunCommand(TARGET);

type Calls = {
  hasDevcontainer: number;
  resolveAssignedPipeline: number;
  runFirstStepDryRun: number;
  confirmRun: number;
  queueRun: number;
  runWorker: number;
};

/**
 * The "everything is ready and the user says yes" baseline; each test negates
 * exactly one port.
 */
function createPorts(overrides: Partial<DesignRunOfferPorts> = {}): {
  ports: DesignRunOfferPorts;
  calls: Calls;
  order: string[];
} {
  const calls: Calls = {
    hasDevcontainer: 0,
    resolveAssignedPipeline: 0,
    runFirstStepDryRun: 0,
    confirmRun: 0,
    queueRun: 0,
    runWorker: 0,
  };
  const order: string[] = [];

  const base: DesignRunOfferPorts = {
    hasDevcontainer: () => {
      calls.hasDevcontainer += 1;
      return Promise.resolve(true);
    },
    resolveAssignedPipeline: () => {
      calls.resolveAssignedPipeline += 1;
      return Promise.resolve(PIPELINE_ID);
    },
    runFirstStepDryRun: () => {
      calls.runFirstStepDryRun += 1;
      order.push("runFirstStepDryRun");
      return Promise.resolve({ ok: true, summary: "healthy" });
    },
    confirmRun: () => {
      calls.confirmRun += 1;
      return Promise.resolve(true);
    },
    queueRun: () => {
      calls.queueRun += 1;
      order.push("queueRun");
      return Promise.resolve();
    },
    runWorker: () => {
      calls.runWorker += 1;
      order.push("runWorker");
      return Promise.resolve();
    },
  };

  return { ports: { ...base, ...overrides }, calls, order };
}

/**
 * Await a rejection and hand back the error. Preferred over `expect().rejects`
 * because these tests go on to assert on side effects that must NOT have
 * happened after the throw.
 */
async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the offer to reject, but it resolved.");
}

describe("formatRunCommand", () => {
  test("targets the one work item the session was about", () => {
    // The user never has to learn the flag exists — but if they copy the line,
    // it has to be the whole command, ready to paste.
    expect(RUN_COMMAND).toBe(
      `boboddy work ${TARGET.projectId} --work-item-id ${TARGET.workItemId}`,
    );
  });
});

describe("runDesignRunOffer", () => {
  test("queues the run and starts the worker when the user accepts", async () => {
    const { reporter } = createRecorder();
    const { ports, calls, order } = createPorts();

    const result = await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(result.ran).toBe(true);
    // The dry-run gate runs before the confirm, and the queue only after it —
    // a worker started before anything is queued has nothing to claim and
    // polls into the void.
    expect(order).toEqual(["runFirstStepDryRun", "queueRun", "runWorker"]);
    expect(calls.confirmRun).toBe(1);
  });

  test("closes the reporter block before the worker owns the terminal", async () => {
    const { reporter } = createRecorder();
    const { ports } = createPorts();
    const order: string[] = [];

    await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter: {
        ...reporter,
        finish: (message) => {
          order.push(`finish:${message}`);
        },
      },
      ports: {
        ...ports,
        runWorker: () => {
          order.push("runWorker");
          return Promise.resolve();
        },
      },
    });

    // The worker opens its own clack block; two live blocks cannot share a tty.
    expect(order).toEqual([`finish:${RUN_LAUNCH_MESSAGE}`, "runWorker"]);
  });

  test("says how to repair a failed run before the worker starts", async () => {
    const { reporter, calls: reported } = createRecorder();
    const { ports } = createPorts();
    const order: string[] = [];

    await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter: {
        ...reporter,
        info: (message) => {
          order.push(`info:${message}`);
          reporter.info(message);
        },
      },
      ports: {
        ...ports,
        runWorker: () => {
          order.push("runWorker");
          return Promise.resolve();
        },
      },
    });

    // The worker swallows step failures into its own polling loop and never
    // returns, so `runWorker` cannot reject on a failed step or a devcontainer
    // that will not build. The only place the repair route can be stated is
    // ahead of the run, where it is still on screen when the failure lands.
    expect(order.indexOf(`info:${RUN_REPAIR_GUIDANCE}`)).toBeGreaterThanOrEqual(
      0,
    );
    expect(order.indexOf(`info:${RUN_REPAIR_GUIDANCE}`)).toBeLessThan(
      order.indexOf("runWorker"),
    );
    expect(messages(reported)).toContain(RUN_REPAIR_GUIDANCE);
  });

  test("names the work item in the confirm", async () => {
    const { reporter } = createRecorder();
    let asked: string | undefined;
    const { ports } = createPorts({
      confirmRun: (title) => {
        asked = title;
        return Promise.resolve(false);
      },
    });

    await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(asked).toBe(TARGET.workItemTitle);
  });

  test("prints the exact command and queues nothing when the user declines", async () => {
    const { reporter, calls: reported } = createRecorder();
    const { ports, calls } = createPorts({
      confirmRun: () => Promise.resolve(false),
    });

    const result = await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(result.ran).toBe(false);
    // Declining is not a deferred yes: nothing is queued on the user's behalf.
    expect(calls.queueRun).toBe(0);
    expect(calls.runWorker).toBe(0);
    // The command gets its own line so it can be copied whole, and the line
    // after it says why it will find nothing until a run is started.
    expect(messages(reported)).toContain(`${RUN_LATER_PREFIX} ${RUN_COMMAND}`);
    expect(messages(reported)).toContain(NOTHING_QUEUED_MESSAGE);
  });

  test("skips the offer and explains itself when there is no devcontainer", async () => {
    const { reporter, calls: reported } = createRecorder();
    const { ports, calls } = createPorts({
      hasDevcontainer: () => Promise.resolve(false),
    });

    const result = await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(result.ran).toBe(false);
    expect(calls.confirmRun).toBe(0);
    expect(calls.queueRun).toBe(0);
    expect(calls.runWorker).toBe(0);
    // Cheap local check first: no reason to ask the server which pipeline is
    // assigned when the run cannot happen either way.
    expect(calls.resolveAssignedPipeline).toBe(0);
    expect(calls.runFirstStepDryRun).toBe(0);
    expect(messages(reported)).toContain(DEVCONTAINER_MISSING_MESSAGE);
    expect(messages(reported)).toContain(`${RUN_LATER_PREFIX} ${RUN_COMMAND}`);
  });

  test("does not offer a run when no pipeline is assigned to run", async () => {
    const { reporter, calls: reported } = createRecorder();
    const { ports, calls } = createPorts({
      resolveAssignedPipeline: () => Promise.resolve(undefined),
    });

    const result = await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(result.ran).toBe(false);
    // Nothing was pushed, so there is nothing to promise the user.
    expect(calls.confirmRun).toBe(0);
    expect(calls.queueRun).toBe(0);
    expect(calls.runWorker).toBe(0);
    expect(messages(reported)).toContain(NO_PIPELINE_MESSAGE);
  });

  test("passes the assigned pipeline id to the first-step dry run", async () => {
    const { reporter } = createRecorder();
    let checked: string | undefined;
    const { ports } = createPorts({
      runFirstStepDryRun: (pipelineDefinitionId) => {
        checked = pipelineDefinitionId;
        return Promise.resolve({ ok: true, summary: "healthy" });
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

  test("blocks the run and explains itself when the first-step dry run fails", async () => {
    const { reporter, calls: reported } = createRecorder();
    const { ports, calls } = createPorts({
      runFirstStepDryRun: () =>
        Promise.resolve({ ok: false, summary: "container exited" }),
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
    expect(messages(reported)).toContain(
      `${FIRST_STEP_DRY_RUN_FAILED_MESSAGE} container exited`,
    );
    expect(messages(reported)).toContain(`${RUN_LATER_PREFIX} ${RUN_COMMAND}`);
  });

  test("checks the first step only after a pipeline is known to be assigned", async () => {
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
    expect(calls.runFirstStepDryRun).toBe(0);
  });

  test("says nothing at all when the designer did not exit cleanly", async () => {
    const { reporter, calls: reported } = createRecorder();
    const { ports, calls } = createPorts();

    const result = await runDesignRunOffer({
      tuiExitedCleanly: false,
      target: TARGET,
      reporter,
      ports,
    });

    expect(result.ran).toBe(false);
    // A crashed or killed session has no result to offer, and the command's
    // exit-code passthrough already speaks for it.
    expect(reported).toEqual([]);
    expect(calls.hasDevcontainer).toBe(0);
    expect(calls.confirmRun).toBe(0);
  });

  test("points a failed queue back at the design command, with the cause", async () => {
    const { reporter } = createRecorder();
    const { ports, calls } = createPorts({
      queueRun: () => Promise.reject(new Error("the pipeline has no steps")),
    });

    const error = await expectRejection(
      runDesignRunOffer({
        tuiExitedCleanly: true,
        target: TARGET,
        reporter,
        ports,
      }),
    );

    // The user never saw this failure, so it has to be restated next to the fix.
    expect(error.message).toContain("the pipeline has no steps");
    expect(error.message).toContain(RUN_REPAIR_GUIDANCE);
    expect(calls.runWorker).toBe(0);
  });

  test("points a failed run back at the design command", async () => {
    const { reporter } = createRecorder();
    const { ports } = createPorts({
      runWorker: () =>
        Promise.reject(new Error("devcontainer build failed: exit 1")),
    });

    const error = await expectRejection(
      runDesignRunOffer({
        tuiExitedCleanly: true,
        target: TARGET,
        reporter,
        ports,
      }),
    );

    // The edit loop is the repair loop — a build failure is something to tell
    // the agent about, not something to debug alone.
    expect(error.message).toContain(RUN_REPAIR_GUIDANCE);
    // The worker printed its own failure through its own reporter; restating it
    // here would show the same paragraph twice.
    expect(error.message).not.toContain("devcontainer build failed");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("passes the assigned pipeline to the queue", async () => {
    const { reporter } = createRecorder();
    let queued: string | undefined;
    const { ports } = createPorts({
      queueRun: (pipelineDefinitionId) => {
        queued = pipelineDefinitionId;
        return Promise.resolve();
      },
    });

    await runDesignRunOffer({
      tuiExitedCleanly: true,
      target: TARGET,
      reporter,
      ports,
    });

    expect(queued).toBe(PIPELINE_ID);
  });
});
