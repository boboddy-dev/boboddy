import {
  HEALTH_CHECK_FAILED_ERROR_CODE,
  HealthCheckFailedError,
} from "./health-check-failed-error";

const WORKER_EXECUTION_FAILED_ERROR_CODE = "BOBODDY_WORKER_EXECUTION_FAILED";

type StepExecutionFailureInputError =
  | Error
  | { message?: string | undefined }
  | string
  | number
  | boolean
  | null
  | undefined;

function toFailureMessage(error: StepExecutionFailureInputError): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : "Unknown failure";
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }

  return "Unknown failure";
}

export function buildStepExecutionFailurePayload(error: StepExecutionFailureInputError) {
  const message = toFailureMessage(error);
  const code =
    error instanceof HealthCheckFailedError
      ? HEALTH_CHECK_FAILED_ERROR_CODE
      : WORKER_EXECUTION_FAILED_ERROR_CODE;

  return {
    resultJson: {
      status: "failed",
    },
    errorJson: {
      code,
      message,
    },
  };
}
