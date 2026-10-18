import {
  formatRunCommand,
  type DesignRunOfferPorts,
  type DesignRunTarget,
  type DryRunGateResult,
  type HealthGateFinding,
} from "../src/lib/design-run-offer";

/** Shared fakes for the `runDesignRunOffer` tests. */

export const TARGET: DesignRunTarget = {
  projectId: "019ed1b9-c02d-7170-a08a-1ff912085f7b",
  project: "acme/web-app",
  workItemId: "019ed1c0-1111-7170-a08a-1ff912085f7b",
  workItemTitle: "Checkout button does nothing on mobile Safari",
};

export const PIPELINE_ID = "019ed1c9-2222-7170-a08a-1ff912085f7b";

export const RUN_COMMAND = formatRunCommand(TARGET);

export const HEALTHY: DryRunGateResult = {
  ok: true,
  summary: "healthy",
  findings: [],
};

export function finding(
  overrides: Partial<HealthGateFinding>,
): HealthGateFinding {
  return {
    stepName: "Fix",
    checkName: "test-runner",
    severity: "required",
    passed: true,
    message: "passed",
    blocking: false,
    ...overrides,
  };
}

export type Calls = {
  resolveAssignedPipeline: number;
  pipelineNeedsProjectDevcontainer: number;
  hasDevcontainer: number;
  runPipelineHealthDryRun: number;
  confirmRun: number;
  queueRun: number;
  runWorker: number;
};

/**
 * The "everything is ready and the user says yes" baseline; each test negates
 * exactly one port.
 */
export function createPorts(overrides: Partial<DesignRunOfferPorts> = {}): {
  ports: DesignRunOfferPorts;
  calls: Calls;
  order: string[];
} {
  const calls: Calls = {
    resolveAssignedPipeline: 0,
    pipelineNeedsProjectDevcontainer: 0,
    hasDevcontainer: 0,
    runPipelineHealthDryRun: 0,
    confirmRun: 0,
    queueRun: 0,
    runWorker: 0,
  };
  const order: string[] = [];

  const base: DesignRunOfferPorts = {
    resolveAssignedPipeline: () => {
      calls.resolveAssignedPipeline += 1;
      return Promise.resolve(PIPELINE_ID);
    },
    pipelineNeedsProjectDevcontainer: () => {
      calls.pipelineNeedsProjectDevcontainer += 1;
      return Promise.resolve(true);
    },
    hasDevcontainer: () => {
      calls.hasDevcontainer += 1;
      return Promise.resolve(true);
    },
    runPipelineHealthDryRun: () => {
      calls.runPipelineHealthDryRun += 1;
      order.push("runPipelineHealthDryRun");
      return Promise.resolve(HEALTHY);
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
export async function expectRejection(
  promise: Promise<unknown>,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the offer to reject, but it resolved.");
}
