import { describe, expect, test } from "bun:test";
import { buildTaskFailurePayload } from "../../../../src/work/task/application/build-task-failure-payload";
import { HealthCheckFailedError } from "../../../../src/work/task/application/health-check-failed-error";

describe("buildTaskFailurePayload", () => {
  test("uses the generic worker-execution-failed code for an ordinary error", () => {
    const payload = buildTaskFailurePayload(new Error("boom"));

    expect(payload.errorJson).toEqual({
      code: "BOBODDY_WORKER_EXECUTION_FAILED",
      message: "boom",
    });
  });

  test("uses the dedicated health-check error code for a HealthCheckFailedError", () => {
    const payload = buildTaskFailurePayload(
      new HealthCheckFailedError('Health check "greet" failed'),
    );

    expect(payload.errorJson).toEqual({
      code: "BOBODDY_HEALTH_CHECK_FAILED",
      message: 'Health check "greet" failed',
    });
  });
});
