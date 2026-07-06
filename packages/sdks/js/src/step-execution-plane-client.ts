import { createClient } from "./generated/client";
import { StepExecutions } from "./generated/sdk.gen";
import type {
  PostApiStepExecutionsByStepExecutionIdArtifactUploadUrlData,
  PostApiStepExecutionsByStepExecutionIdArtifactsData,
} from "./generated/types.gen";

type CreateArtifactUploadUrlInput =
  PostApiStepExecutionsByStepExecutionIdArtifactUploadUrlData["body"];

type RecordStepExecutionArtifactInput =
  PostApiStepExecutionsByStepExecutionIdArtifactsData["body"];

type RequestOptions = {
  headers?: Record<string, unknown> | undefined;
};

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export function createStepExecutionPlaneClient(
  baseUrl: string,
): ReturnType<typeof buildStepExecutionPlaneClient> {
  const client = createClient({ baseUrl });
  return buildStepExecutionPlaneClient(new StepExecutions({ client }));
}

const buildStepExecutionPlaneClient = (stepExecutions: StepExecutions) => {
  return {
    claimStepExecutions: async (
      body: {
        projectId: string;
        workerId: string;
        batchSize: number;
        leaseDurationSeconds: number;
        workItemId?: string | undefined;
      },
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.claimStepExecutions({
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    heartbeatStepExecution: async (
      stepExecutionId: string,
      body: {
        claimToken: string;
        leaseDurationSeconds: number;
      },
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.heartbeatStepExecution({
        path: { stepExecutionId },
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
    },
    getStepExecution: async (
      stepExecutionId: string,
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.getStepExecution({
        path: { stepExecutionId },
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    getStepExecutionWorkerContext: async (
      stepExecutionId: string,
      body: {
        claimToken: string;
      },
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.getStepExecutionWorkerContext({
        path: { stepExecutionId },
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    completeStepExecution: async (
      stepExecutionId: string,
      body: {
        claimToken: string;
        status: "succeeded" | "failed";
        resultJson: JsonValue;
        errorJson: JsonValue;
      },
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.completeStepExecution({
        path: { stepExecutionId },
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
    },
    failStepExecution: async (
      stepExecutionId: string,
      body: {
        claimToken: string;
        resultJson: JsonValue;
        errorJson: JsonValue;
      },
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.completeStepExecution({
        path: { stepExecutionId },
        body: { ...body, status: "failed" as const },
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
    },
    createArtifactUploadUrl: async (
      stepExecutionId: string,
      body: CreateArtifactUploadUrlInput,
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.createArtifactUploadUrl({
        path: { stepExecutionId },
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    recordStepExecutionArtifact: async (
      stepExecutionId: string,
      body: RecordStepExecutionArtifactInput,
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.recordStepExecutionArtifact({
        path: { stepExecutionId },
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    listStepExecutionArtifacts: async (
      stepExecutionId: string,
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.listStepExecutionArtifacts({
        path: { stepExecutionId },
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    getArtifactDownloadUrl: async (
      stepExecutionId: string,
      artifactId: string,
      options?: RequestOptions,
    ) => {
      const result = await stepExecutions.getArtifactDownloadUrl({
        path: { stepExecutionId, artifactId },
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    appendStepExecutionLogs: async (
      stepExecutionId: string,
      body: {
        claimToken: string;
        lines: {
          seq: number;
          stream: "worker" | "ai-server" | "conversation";
          ts: string;
          content: string;
          level: "debug" | "info" | "warn" | "error";
        }[];
      },
      options?: RequestOptions,
    ): Promise<{ nextOffset: number }> => {
      const result = await stepExecutions.appendStepExecutionLogs({
        path: { stepExecutionId },
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
  };
};
