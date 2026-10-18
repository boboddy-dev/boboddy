import { CoreValidationError } from "../../../lib/errors";
import type { ProcessProjectWorkInput } from "../contracts/process-project-work-types";

function assertPositiveInt(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CoreValidationError(
      `${fieldName} must be a positive integer`,
      "PROCESS_PROJECT_WORK_INVALID_CONFIG",
      {
        fieldName,
        value,
      },
    );
  }
}

function assertWorkerId(workerId: string) {
  if (!workerId.trim()) {
    throw new CoreValidationError(
      "workerId must be a non-empty string",
      "PROCESS_PROJECT_WORK_INVALID_CONFIG",
    );
  }
}

export function validateProcessProjectWorkInput(
  input: ProcessProjectWorkInput,
) {
  assertWorkerId(input.workerId);
  assertPositiveInt(input.batchSize, "batchSize");
  assertPositiveInt(input.concurrency, "concurrency");
  assertPositiveInt(input.pollIntervalMs, "pollIntervalMs");
  assertPositiveInt(input.leaseDurationSeconds, "leaseDurationSeconds");

  if (input.maxPollIntervalMs !== undefined) {
    assertPositiveInt(input.maxPollIntervalMs, "maxPollIntervalMs");

    if (input.maxPollIntervalMs < input.pollIntervalMs) {
      throw new CoreValidationError(
        "maxPollIntervalMs must be greater than or equal to pollIntervalMs",
        "PROCESS_PROJECT_WORK_INVALID_CONFIG",
        {
          maxPollIntervalMs: input.maxPollIntervalMs,
          pollIntervalMs: input.pollIntervalMs,
        },
      );
    }
  }
}
