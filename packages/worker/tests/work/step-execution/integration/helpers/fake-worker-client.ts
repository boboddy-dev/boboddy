import type { UuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type {
  StepExecutionWorkerClaim,
  StepExecutionWorkerClient,
} from "../../../../../src/work/step-execution/contracts/process-project-work-types";
import type { StepExecutionContract } from "../../../../../src/work/step-execution/contracts/step-execution-contracts";
import { createUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type { WorkScenario } from "./scenario";

export type CompleteStepExecutionCall = {
  stepExecutionId: UuidV7;
  claimToken: string;
  resultJson: unknown;
  errorJson: unknown;
};

export type FailStepExecutionCall = CompleteStepExecutionCall;

export type HeartbeatStepExecutionCall = {
  stepExecutionId: UuidV7;
  claimToken: string;
  leaseDurationSeconds: number;
};

/**
 * In-memory programmable StepExecutionWorkerClient. Replaces the real HTTP
 * worker-api-client so integration tests don't need a running platform server.
 *
 * - claimStepExecutions hands out the scenario's steps exactly once, then
 *   returns [] so the polling loop terminates.
 * - getStepExecutionWorkerContext returns the scenario's worker context.
 * - getStepExecution reports "running" until the step is completed/failed,
 *   then reflects that terminal status.
 * - complete/fail/heartbeat calls are recorded for assertions.
 */
export class FakeStepExecutionWorkerClient implements StepExecutionWorkerClient {
  readonly userId: UuidV7;

  readonly completeCalls: CompleteStepExecutionCall[] = [];
  readonly failCalls: FailStepExecutionCall[] = [];
  readonly heartbeatCalls: HeartbeatStepExecutionCall[] = [];

  private claimsDispensed = false;
  private readonly claimTokensByStep = new Map<string, string>();
  private readonly terminalStatusByStep = new Map<
    string,
    StepExecutionContract["status"]
  >();

  constructor(private readonly scenario: WorkScenario) {
    this.userId = createUuidV7();
  }

  claimStepExecutions(input: {
    projectId: UuidV7;
    workerId: string;
    batchSize: number;
    leaseDurationSeconds: number;
    workItemId?: string | undefined;
  }): Promise<StepExecutionWorkerClaim[]> {
    if (this.claimsDispensed) {
      return Promise.resolve([]);
    }
    this.claimsDispensed = true;

    const claims: StepExecutionWorkerClaim[] = this.scenario.steps
      .slice(0, input.batchSize)
      .map((step) => {
        const claimToken = createUuidV7();
        this.claimTokensByStep.set(step.stepExecutionId, claimToken);
        return {
          stepExecution: { id: step.stepExecutionId },
          claimToken,
        };
      });

    return Promise.resolve(claims);
  }

  heartbeatStepExecution(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
    leaseDurationSeconds: number;
  }): Promise<void> {
    this.heartbeatCalls.push({ ...input });
    return Promise.resolve();
  }

  failStepExecution(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
  }): Promise<void> {
    this.failCalls.push({ ...input });
    this.terminalStatusByStep.set(input.stepExecutionId, "failed");
    return Promise.resolve();
  }

  completeStepExecution(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
  }): Promise<void> {
    this.completeCalls.push({ ...input });
    this.terminalStatusByStep.set(input.stepExecutionId, "succeeded");
    return Promise.resolve();
  }

  getStepExecution(input: {
    stepExecutionId: UuidV7;
  }): Promise<Pick<StepExecutionContract, "status">> {
    return Promise.resolve({
      status: this.terminalStatusByStep.get(input.stepExecutionId) ?? "running",
    });
  }

  getStepExecutionWorkerContext(input: {
    stepExecutionId: UuidV7;
    claimToken: string;
  }): Promise<
    import("../../../../../src/work/step-execution/contracts/step-execution-contracts").StepExecutionWorkerContextContract
  > {
    const step = this.scenario.steps.find(
      (candidate) => candidate.stepExecutionId === input.stepExecutionId,
    );

    if (!step) {
      throw new Error(
        `No scenario step configured for stepExecutionId=${input.stepExecutionId}`,
      );
    }

    return Promise.resolve(step.workerContext);
  }
}
