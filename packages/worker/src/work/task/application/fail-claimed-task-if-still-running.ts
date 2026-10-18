import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import { buildTaskFailurePayload } from "./build-task-failure-payload";
import type {
  ProjectWorkLogger,
  TaskWorkerClient,
} from "../contracts/process-project-work-types";

type ClaimedTaskFailureInputError =
  | Error
  | { message?: string | undefined }
  | string
  | number
  | boolean
  | null
  | undefined;

function getFailureMessage(
  errorJson: { message?: string | undefined } | null | undefined,
) {
  if (errorJson && typeof errorJson === "object" && "message" in errorJson) {
    return String(errorJson.message);
  }

  return "unknown";
}

export async function failClaimedTaskIfStillRunning(
  client: TaskWorkerClient,
  logger: ProjectWorkLogger,
  input: {
    taskId: UuidV7;
    claimToken: string;
    error: ClaimedTaskFailureInputError;
  },
) {
  logger.log("step", "Checking claimed step status after failure", {
    taskId: input.taskId,
  });
  const task = await client.getTask({
    taskId: input.taskId,
  });

  if (task.status !== "running") {
    logger.log(
      "step",
      "Claimed step already left running state after failure",
      {
        taskId: input.taskId,
        status: task.status,
      },
    );
    return task.status;
  }

  const failurePayload = buildTaskFailurePayload(input.error);
  logger.log("step", "Reporting claimed step failure", {
    taskId: input.taskId,
    code: failurePayload.errorJson.code,
    message: getFailureMessage(failurePayload.errorJson),
  });
  await client.failTask({
    taskId: input.taskId,
    claimToken: input.claimToken,
    resultJson: failurePayload.resultJson,
    errorJson: failurePayload.errorJson,
  });

  logger.log("step", "Reported claimed step failure", {
    taskId: input.taskId,
    status: "failed",
  });
  return "failed";
}
