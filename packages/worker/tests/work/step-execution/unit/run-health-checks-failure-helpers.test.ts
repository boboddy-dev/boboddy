import { describe, expect, test } from "bun:test";
import {
  describeFailedHealthCheck,
  findFailedRequiredHealthCheck,
  type HealthCheckReport,
} from "../../../../src/work/step-execution/application/run-health-checks";

/**
 * #120: the real step-execution gate calls these two pure helpers to decide
 * whether to kill the step and how to describe why — covered directly here
 * rather than only indirectly through `process-claimed-step-execution.test.ts`.
 */
describe("findFailedRequiredHealthCheck", () => {
  function report(overrides: Partial<HealthCheckReport>): HealthCheckReport {
    return {
      name: "greet",
      resolvedId: "greet",
      severity: "required",
      outcome: { kind: "passed" },
      ...overrides,
    };
  }

  test("returns undefined when every required check passed", () => {
    const reports = [
      report({ severity: "required" }),
      report({ name: "optional", severity: "warn", outcome: { kind: "skipped" } }),
    ];

    expect(findFailedRequiredHealthCheck(reports)).toBeUndefined();
  });

  test("ignores a failed warn check", () => {
    const reports = [
      report({
        name: "advisory",
        severity: "warn",
        outcome: { kind: "failed", reason: "tool-error", detail: "boom" },
      }),
    ];

    expect(findFailedRequiredHealthCheck(reports)).toBeUndefined();
  });

  test("finds the first failed required check, in report order", () => {
    const failing = report({
      name: "second",
      severity: "required",
      outcome: { kind: "failed", reason: "timeout", detail: "timed out after 1s" },
    });
    const reports = [report({ name: "first", severity: "required" }), failing];

    const found = findFailedRequiredHealthCheck(reports);

    expect(found?.report).toBe(failing);
    expect(found?.outcome).toEqual({
      kind: "failed",
      reason: "timeout",
      detail: "timed out after 1s",
    });
  });
});

describe("describeFailedHealthCheck", () => {
  test("renders name, resolvedId, reason, and detail", () => {
    const failedReport: HealthCheckReport = {
      name: "Browser reachable",
      resolvedId: "browser_navigate",
      severity: "required",
      outcome: { kind: "failed", reason: "tool-error", detail: "connection refused" },
    };

    const message = describeFailedHealthCheck(
      failedReport,
      failedReport.outcome as Extract<
        HealthCheckReport["outcome"],
        { kind: "failed" }
      >,
    );

    expect(message).toBe(
      'Health check "Browser reachable" (browser_navigate) failed [tool-error]: connection refused',
    );
  });

  test("appends the available tool ids for a not-registered failure", () => {
    const failedReport: HealthCheckReport = {
      name: "greet",
      resolvedId: "greet",
      severity: "required",
      outcome: {
        kind: "failed",
        reason: "not-registered",
        detail: 'Tool "greet" is not registered in this environment.',
        availableIds: ["bash", "read"],
      },
    };

    const message = describeFailedHealthCheck(
      failedReport,
      failedReport.outcome as Extract<
        HealthCheckReport["outcome"],
        { kind: "failed" }
      >,
    );

    expect(message).toBe(
      'Health check "greet" (greet) failed [not-registered]: Tool "greet" is not registered in this environment. Available tool ids: bash, read.',
    );
  });
});
