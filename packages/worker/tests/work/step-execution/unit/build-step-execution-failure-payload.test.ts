import { describe, expect, test } from "bun:test";
import { buildStepExecutionFailurePayload } from "../../../../src/work/step-execution/application/build-step-execution-failure-payload";
import { HealthCheckFailedError } from "../../../../src/work/step-execution/application/health-check-failed-error";

describe("buildStepExecutionFailurePayload", () => {
  test("uses the generic worker-execution-failed code for an ordinary error", () => {
    const payload = buildStepExecutionFailurePayload(new Error("boom"));

    expect(payload.errorJson).toEqual({
      code: "BOBODDY_WORKER_EXECUTION_FAILED",
      message: "boom",
    });
  });

  test("uses the dedicated health-check error code for a HealthCheckFailedError", () => {
    const payload = buildStepExecutionFailurePayload(
      new HealthCheckFailedError('Health check "greet" failed'),
    );

    expect(payload.errorJson).toEqual({
      code: "BOBODDY_HEALTH_CHECK_FAILED",
      message: 'Health check "greet" failed',
    });
  });
});
