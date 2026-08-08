/**
 * Dedicated error code for a step killed by a failing `required` health
 * check (#120), distinct from `BOBODDY_WORKER_EXECUTION_FAILED` (the single
 * generic worker-failure code used for every other execution failure). This
 * makes an unhealthy environment machine-distinguishable from an agent
 * failure without string-matching the error message.
 */
export const HEALTH_CHECK_FAILED_ERROR_CODE = "BOBODDY_HEALTH_CHECK_FAILED";

/**
 * Thrown by claimed-step execution when a `required` health check fails,
 * before the agent is prompted. Thrown from inside the same `try` block as
 * the rest of the launch sequence, so it reuses the existing failure
 * handling as-is: cleanup of the container/workspace, log flush before the
 * status change, and the standard claimed-step failure path (see
 * `process-claimed-step-execution.ts`).
 *
 * `buildStepExecutionFailurePayload` checks `instanceof` this class to pick
 * {@link HEALTH_CHECK_FAILED_ERROR_CODE} over the generic code — an
 * `instanceof` check rather than string-matching the message, per #120.
 */
export class HealthCheckFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthCheckFailedError";
  }
}
