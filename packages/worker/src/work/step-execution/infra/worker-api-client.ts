import { createStepExecutionPlaneClient } from "@boboddy/sdk";
import type { ArtifactKind } from "@boboddy/sdk/contracts/artifacts";
import { parseUuidV7, type UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  StepExecutionLogLine,
  StepExecutionWorkerClient,
} from "../contracts/process-project-work-types";
import type { StepExecutionWorkerContextContract } from "../contracts/step-execution-contracts";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";

export type StepExecutionWorkerContext = StepExecutionWorkerContextContract;

export type StepExecutionPlaneWorkerClient = StepExecutionWorkerClient;

function buildAuthHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

export async function createStepExecutionPlaneWorkerClient(baseUrl: string) {
  const authenticated = await loadAuthenticatedSession(baseUrl);

  if (!authenticated) {
    throw new Error(`Not signed in to ${baseUrl}.`);
  }

  const planeClient = createStepExecutionPlaneClient(baseUrl);
  const headers = buildAuthHeaders(authenticated.profile.accessToken);

  return {
    userId: parseUuidV7(authenticated.session.user.id),
    claimStepExecutions: async (input: {
      projectId: UuidV7;
      workerId: string;
      batchSize: number;
      leaseDurationSeconds: number;
      workItemId?: string | undefined;
    }) => {
      const results = await planeClient.claimStepExecutions(input, { headers });
      return results.map((r) => ({
        stepExecution: { id: parseUuidV7(r.stepExecution.id) },
        claimToken: r.claimToken,
      }));
    },
    heartbeatStepExecution: async (input: {
      stepExecutionId: UuidV7;
      claimToken: string;
      leaseDurationSeconds: number;
    }) => {
      await planeClient.heartbeatStepExecution(
        input.stepExecutionId,
        {
          claimToken: input.claimToken,
          leaseDurationSeconds: input.leaseDurationSeconds,
        },
        { headers },
      );
    },
    failStepExecution: async (input: {
      stepExecutionId: UuidV7;
      claimToken: string;
      resultJson: unknown;
      errorJson: unknown;
    }) => {
      await planeClient.failStepExecution(
        input.stepExecutionId,
        {
          claimToken: input.claimToken,
          resultJson: input.resultJson as never,
          errorJson: input.errorJson as never,
        },
        { headers },
      );
    },
    completeStepExecution: async (input: {
      stepExecutionId: UuidV7;
      claimToken: string;
      resultJson: unknown;
      errorJson: unknown;
      workBranch: string | null;
      createdFromBranch: string | null;
    }) => {
      await planeClient.completeStepExecution(
        input.stepExecutionId,
        {
          claimToken: input.claimToken,
          status: "succeeded",
          resultJson: input.resultJson as never,
          errorJson: input.errorJson as never,
          workBranch: input.workBranch,
          createdFromBranch: input.createdFromBranch,
        },
        { headers },
      );
    },
    appendStepExecutionLogs: async (input: {
      stepExecutionId: UuidV7;
      claimToken: string;
      lines: StepExecutionLogLine[];
    }) =>
      await planeClient.appendStepExecutionLogs(
        input.stepExecutionId,
        { claimToken: input.claimToken, lines: input.lines },
        { headers },
      ),
    getStepExecution: async (input: { stepExecutionId: UuidV7 }) =>
      await planeClient.getStepExecution(input.stepExecutionId, { headers }),
    getStepExecutionWorkerContext: async (input: {
      stepExecutionId: UuidV7;
      claimToken: string;
    }) =>
      (await planeClient.getStepExecutionWorkerContext(
        input.stepExecutionId,
        {
          claimToken: input.claimToken,
        },
        { headers },
      )) as unknown as StepExecutionWorkerContextContract,
    createArtifactUploadUrl: async (input: {
      stepExecutionId: string;
      claimToken: string;
      relativeStorePath: string;
      contentType?: string | undefined;
      sizeBytes?: number | undefined;
    }) =>
      await planeClient.createArtifactUploadUrl(
        input.stepExecutionId,
        {
          claimToken: input.claimToken,
          relativeStorePath: input.relativeStorePath,
          ...(input.contentType === undefined
            ? {}
            : { contentType: input.contentType }),
          ...(input.sizeBytes === undefined
            ? {}
            : { sizeBytes: input.sizeBytes }),
        },
        { headers },
      ),
    recordArtifact: async (input: {
      stepExecutionId: string;
      claimToken: string;
      objectKey: string;
      relativeStorePath: string;
      sizeBytes: number;
      contentType?: string | undefined;
      kind: ArtifactKind;
    }) => {
      await planeClient.recordStepExecutionArtifact(
        input.stepExecutionId,
        {
          claimToken: input.claimToken,
          objectKey: input.objectKey,
          relativeStorePath: input.relativeStorePath,
          sizeBytes: input.sizeBytes,
          kind: input.kind,
          ...(input.contentType === undefined
            ? {}
            : { contentType: input.contentType }),
        },
        { headers },
      );
    },
  } satisfies StepExecutionPlaneWorkerClient;
}
