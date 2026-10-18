import { createTaskPlaneClient } from "@boboddy/sdk";
import {
  loadTaskLogLines,
  type TaskLogsClient,
} from "@boboddy/platform-client";
import { parseUuidV7 } from "../../../common/contracts/uuid-v7";
import type { TaskWorkerClient } from "../contracts/process-project-work-types";
import type { TaskWorkerContextContract } from "../contracts/task-contracts";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";

export type TaskPlaneWorkerClient = TaskWorkerClient;

type TaskPlaneClient = Pick<
  ReturnType<typeof createTaskPlaneClient>,
  "getTask" | "getTaskLogArchive" | "readTaskLogs"
>;

/**
 * Adapts the plane client's log reads to `@boboddy/platform-client`'s
 * {@link TaskLogsClient}. The plane client already sends the bearer token, so
 * the per-call `headers` that interface carries are ignored. The cast covers
 * the generated SDK typing nullable fields as `T | unknown` (see
 * `InvestigateExecutionClient`); the runtime shapes match.
 */
export function toTaskLogsClient(planeClient: TaskPlaneClient): TaskLogsClient {
  return {
    tasks: {
      getTaskLogArchive: ({ path }: { path: { taskId: string } }) =>
        planeClient.getTaskLogArchive({ taskId: path.taskId }),
      readTaskLogs: ({
        path,
        query,
      }: {
        path: { taskId: string };
        query: { from: number; limit: number };
      }) => planeClient.readTaskLogs({ taskId: path.taskId, ...query }),
    },
  } as unknown as TaskLogsClient;
}

/**
 * Reads another Task's log lines. `loadTaskLogLines` picks the archive or the
 * live feed from `completedAt`, which the worker context does not carry, so
 * the Task is fetched first.
 */
export function buildLoadTaskLogLines(
  planeClient: TaskPlaneClient,
): NonNullable<TaskWorkerClient["loadTaskLogLines"]> {
  const logsClient = toTaskLogsClient(planeClient);
  return async ({ taskId }) => {
    const task = await planeClient.getTask({ taskId });
    const completedAt =
      typeof task.completedAt === "string" ? task.completedAt : null;
    return await loadTaskLogLines(
      logsClient,
      { Authorization: "" },
      { id: taskId, completedAt },
    );
  };
}

export async function createTaskPlaneWorkerClient(
  baseUrl: string,
): Promise<TaskPlaneWorkerClient> {
  const authenticated = await loadAuthenticatedSession(baseUrl);

  if (!authenticated) {
    throw new Error(`Not signed in to ${baseUrl}.`);
  }

  const planeClient = createTaskPlaneClient(baseUrl, {
    headers: { Authorization: `Bearer ${authenticated.profile.accessToken}` },
  });

  return {
    ...planeClient,
    userId: parseUuidV7(authenticated.session.user.id),
    claimTasks: async (input) =>
      (await planeClient.claimTasks(input)).map((claim) => ({
        ...claim,
        task: { ...claim.task, id: parseUuidV7(claim.task.id) },
      })),
    getTaskWorkerContext: async (input) =>
      (await planeClient.getTaskWorkerContext(
        input,
      )) as TaskWorkerContextContract,
    loadTaskLogLines: buildLoadTaskLogLines(planeClient),
  };
}
