import { createClient } from "./generated/client";
import { Tasks } from "./generated/sdk.gen";
import type {
  GetApiTasksByTaskIdLogsData,
  PostApiTasksByTaskIdArtifactFailuresData,
  PostApiTasksByTaskIdArtifactUploadUrlData,
  PostApiTasksByTaskIdArtifactsData,
  PostApiTasksByTaskIdCompletionsData,
  PostApiTasksByTaskIdLogsData,
  PostApiTasksClaimsData,
} from "./generated/types.gen";

type TaskRef = { taskId: string };

type CompletionBody = PostApiTasksByTaskIdCompletionsData["body"];

export type TaskPlaneClientOptions = {
  headers?: Record<string, string> | undefined;
};

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.data as T;
}

/**
 * Worker-facing client for the Task plane (`/api/tasks/...`): claiming,
 * heartbeating, context, logs (writing, and reading another Task's), artifacts
 * and completion. Headers given here
 * (typically the worker's bearer token) are sent with every request.
 */
export function createTaskPlaneClient(
  baseUrl: string,
  options?: TaskPlaneClientOptions,
): ReturnType<typeof buildTaskPlaneClient> {
  const client = createClient({ baseUrl, headers: options?.headers });
  return buildTaskPlaneClient(new Tasks({ client }));
}

const buildTaskPlaneClient = (tasks: Tasks) => {
  return {
    claimTasks: async (input: PostApiTasksClaimsData["body"]) =>
      unwrap(await tasks.claimTasks({ body: input })),
    heartbeatTask: async ({
      taskId,
      ...body
    }: TaskRef & { claimToken: string; leaseDurationSeconds: number }) => {
      unwrap(await tasks.heartbeatTask({ path: { taskId }, body }));
    },
    getTask: async ({ taskId }: TaskRef) =>
      unwrap(await tasks.getTask({ path: { taskId } })),
    /** Not unwrapped: callers read `error.status` (e.g. a 402 read quota). */
    getTaskLogArchive: ({ taskId }: TaskRef) =>
      tasks.getTaskLogArchive({ path: { taskId } }),
    /** Not unwrapped: callers read `error.status`. */
    readTaskLogs: ({
      taskId,
      ...query
    }: TaskRef & GetApiTasksByTaskIdLogsData["query"]) =>
      tasks.readTaskLogs({ path: { taskId }, query }),
    getTaskWorkerContext: async ({
      taskId,
      ...body
    }: TaskRef & { claimToken: string }) =>
      unwrap(await tasks.getTaskWorkerContext({ path: { taskId }, body })),
    completeTask: async ({
      taskId,
      ...body
    }: TaskRef & Omit<CompletionBody, "status">) => {
      unwrap(
        await tasks.completeTask({
          path: { taskId },
          body: { ...body, status: "succeeded" },
        }),
      );
    },
    failTask: async ({
      taskId,
      ...body
    }: TaskRef &
      Omit<CompletionBody, "status" | "workBranch" | "createdFromBranch">) => {
      unwrap(
        await tasks.completeTask({
          path: { taskId },
          body: { ...body, status: "failed" },
        }),
      );
    },
    appendTaskLogs: async ({
      taskId,
      ...body
    }: TaskRef & PostApiTasksByTaskIdLogsData["body"]) =>
      unwrap(await tasks.appendTaskLogs({ path: { taskId }, body })),
    createArtifactUploadUrl: async ({
      taskId,
      ...body
    }: TaskRef & PostApiTasksByTaskIdArtifactUploadUrlData["body"]) =>
      unwrap(await tasks.createArtifactUploadUrl({ path: { taskId }, body })),
    recordArtifact: async ({
      taskId,
      ...body
    }: TaskRef & PostApiTasksByTaskIdArtifactsData["body"]) => {
      unwrap(await tasks.recordTaskArtifact({ path: { taskId }, body }));
    },
    recordArtifactFailure: async ({
      taskId,
      ...body
    }: TaskRef & PostApiTasksByTaskIdArtifactFailuresData["body"]) => {
      unwrap(await tasks.recordTaskArtifactFailure({ path: { taskId }, body }));
    },
    listTaskArtifacts: async ({ taskId }: TaskRef) =>
      unwrap(await tasks.listTaskArtifacts({ path: { taskId } })),
    getArtifactDownloadUrl: async ({
      taskId,
      artifactId,
    }: TaskRef & { artifactId: string }) =>
      unwrap(
        await tasks.getArtifactDownloadUrl({ path: { taskId, artifactId } }),
      ),
  };
};
