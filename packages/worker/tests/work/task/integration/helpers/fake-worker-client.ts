import type { TaskLogLinesResult } from "@boboddy/platform-client";
import type { ArtifactKind } from "@boboddy/sdk/contracts/artifacts";
import type { UuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type {
  TaskLogLine,
  TaskWorkerClaim,
  TaskWorkerClient,
} from "../../../../../src/work/task/contracts/process-project-work-types";
import type {
  TaskContract,
  TaskWorkerContextContract,
} from "../../../../../src/work/task/contracts/task-contracts";
import { createUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type { WorkScenario } from "./scenario";

export type FailTaskCall = {
  taskId: UuidV7;
  claimToken: string;
  resultJson: unknown;
  errorJson: unknown;
};

export type CompleteTaskCall = FailTaskCall & {
  workBranch: string | null;
  createdFromBranch: string | null;
};

export type HeartbeatTaskCall = {
  taskId: UuidV7;
  claimToken: string;
  leaseDurationSeconds: number;
};

/**
 * In-memory programmable TaskWorkerClient. Replaces the real HTTP
 * worker-api-client so integration tests don't need a running platform server.
 *
 * - claimTasks hands out the scenario's steps exactly once, then
 *   returns [] so the polling loop terminates.
 * - getTaskWorkerContext returns the scenario's worker context.
 * - getTask reports "running" until the step is completed/failed,
 *   then reflects that terminal status.
 * - complete/fail/heartbeat calls are recorded for assertions.
 */
export class FakeTaskWorkerClient implements TaskWorkerClient {
  readonly userId: UuidV7;

  readonly completeCalls: CompleteTaskCall[] = [];
  readonly failCalls: FailTaskCall[] = [];
  readonly heartbeatCalls: HeartbeatTaskCall[] = [];

  private claimsDispensed = false;
  private readonly claimTokensByStep = new Map<string, string>();
  private readonly terminalStatusByStep = new Map<
    string,
    TaskContract["status"]
  >();

  readonly loadTaskLogLinesCalls: string[] = [];

  constructor(
    private readonly scenario: WorkScenario,
    private readonly taskLogLines?: (taskId: string) => TaskLogLinesResult,
  ) {
    this.userId = createUuidV7();
  }

  loadTaskLogLines(input: { taskId: string }): Promise<TaskLogLinesResult> {
    this.loadTaskLogLinesCalls.push(input.taskId);
    return Promise.resolve(
      this.taskLogLines?.(input.taskId) ?? {
        unavailable: "no logs configured for this scenario",
      },
    );
  }

  claimTasks(input: {
    projectId: UuidV7;
    workerId: string;
    batchSize: number;
    leaseDurationSeconds: number;
    workItemId?: string | undefined;
  }): Promise<TaskWorkerClaim[]> {
    if (this.claimsDispensed) {
      return Promise.resolve([]);
    }
    this.claimsDispensed = true;

    const claims: TaskWorkerClaim[] = this.scenario.steps
      .slice(0, input.batchSize)
      .map((step) => {
        const claimToken = createUuidV7();
        this.claimTokensByStep.set(step.taskId, claimToken);
        return {
          task: { id: step.taskId },
          claimToken,
        };
      });

    return Promise.resolve(claims);
  }

  readonly appendedLogLines: TaskLogLine[] = [];

  appendTaskLogs(input: {
    taskId: UuidV7;
    claimToken: string;
    lines: TaskLogLine[];
  }): Promise<{ nextOffset: number }> {
    this.appendedLogLines.push(...input.lines);
    const last = input.lines[input.lines.length - 1];
    return Promise.resolve({ nextOffset: last ? last.seq : 0 });
  }

  heartbeatTask(input: {
    taskId: UuidV7;
    claimToken: string;
    leaseDurationSeconds: number;
  }): Promise<void> {
    this.heartbeatCalls.push({ ...input });
    return Promise.resolve();
  }

  failTask(input: {
    taskId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
  }): Promise<void> {
    this.failCalls.push({ ...input });
    this.terminalStatusByStep.set(input.taskId, "failed");
    return Promise.resolve();
  }

  completeTask(input: {
    taskId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
    workBranch: string | null;
    createdFromBranch: string | null;
  }): Promise<void> {
    this.completeCalls.push({ ...input });
    this.terminalStatusByStep.set(input.taskId, "succeeded");
    return Promise.resolve();
  }

  getTask(input: { taskId: UuidV7 }): Promise<Pick<TaskContract, "status">> {
    return Promise.resolve({
      status: this.terminalStatusByStep.get(input.taskId) ?? "running",
    });
  }

  getTaskWorkerContext(input: {
    taskId: UuidV7;
    claimToken: string;
  }): Promise<TaskWorkerContextContract> {
    const step = this.scenario.steps.find(
      (candidate) => candidate.taskId === input.taskId,
    );

    if (!step) {
      throw new Error(`No scenario step configured for taskId=${input.taskId}`);
    }

    return Promise.resolve(step.workerContext);
  }

  readonly artifactUploadUrlCalls: {
    taskId: string;
    claimToken: string;
    relativeStorePath: string;
    contentType?: string | undefined;
  }[] = [];

  readonly recordedArtifacts: {
    taskId: string;
    claimToken: string;
    objectKey: string;
    relativeStorePath: string;
    sizeBytes: number;
    contentType?: string | undefined;
    kind: ArtifactKind;
  }[] = [];

  createArtifactUploadUrl(input: {
    taskId: string;
    claimToken: string;
    relativeStorePath: string;
    contentType?: string | undefined;
  }): Promise<{
    uploadUrl: string;
    storeRef: string;
    objectKey: string;
    expiresInSeconds: number;
  }> {
    this.artifactUploadUrlCalls.push({ ...input });
    const objectKey = `${input.taskId}/${input.relativeStorePath}`;
    return Promise.resolve({
      uploadUrl: `https://fake-upload.local/${objectKey}`,
      storeRef: `remote://${objectKey}`,
      objectKey,
      expiresInSeconds: 300,
    });
  }

  recordArtifact(input: {
    taskId: string;
    claimToken: string;
    objectKey: string;
    relativeStorePath: string;
    sizeBytes: number;
    contentType?: string | undefined;
    kind: ArtifactKind;
  }): Promise<void> {
    this.recordedArtifacts.push({ ...input });
    return Promise.resolve();
  }

  readonly recordedArtifactFailures: {
    taskId: string;
    claimToken: string;
    relativeStorePath: string;
    attemptedSizeBytes: number;
    kind?: ArtifactKind | undefined;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number | undefined;
  }[] = [];

  recordArtifactFailure(input: {
    taskId: string;
    claimToken: string;
    relativeStorePath: string;
    attemptedSizeBytes: number;
    kind?: ArtifactKind | undefined;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number | undefined;
  }): Promise<void> {
    this.recordedArtifactFailures.push({ ...input });
    return Promise.resolve();
  }
}
