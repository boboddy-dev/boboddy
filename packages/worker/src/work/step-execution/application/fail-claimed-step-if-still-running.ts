import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import { buildStepExecutionFailurePayload } from "./build-step-execution-failure-payload";
import type {
  ProjectWorkLogger,
  StepExecutionWorkerClient,
} from "../contracts/process-project-work-types";

type ClaimedStepFailureInputError =
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

export async function failClaimedStepIfStillRunning(
  client: StepExecutionWorkerClient,
  logger: ProjectWorkLogger,
  input: {
    stepExecutionId: UuidV7;
    claimToken: string;
    error: ClaimedStepFailureInputError;
  },
) {
  logger.log("step", "Checking claimed step status after failure", {
    stepExecutionId: input.stepExecutionId,
  });
  const stepExecution = await client.getStepExecution({
    stepExecutionId: input.stepExecutionId,
  });

  if (stepExecution.status !== "running") {
    logger.log(
      "step",
      "Claimed step already left running state after failure",
      {
        stepExecutionId: input.stepExecutionId,
        status: stepExecution.status,
      },
    );
    return stepExecution.status;
  }

  const failurePayload = buildStepExecutionFailurePayload(input.error);
  logger.log("step", "Reporting claimed step failure", {
    stepExecutionId: input.stepExecutionId,
    code: failurePayload.errorJson.code,
    message: getFailureMessage(failurePayload.errorJson),
  });
  await client.failStepExecution({
    stepExecutionId: input.stepExecutionId,
    claimToken: input.claimToken,
    resultJson: failurePayload.resultJson,
    errorJson: failurePayload.errorJson,
  });

  logger.log("step", "Reported claimed step failure", {
    stepExecutionId: input.stepExecutionId,
    status: "failed",
  });
  return "failed";
}
