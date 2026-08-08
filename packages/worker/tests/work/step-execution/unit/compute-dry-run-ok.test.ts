import { describe, expect, test } from "bun:test";
import { computeDryRunOk } from "../../../../src/work/step-execution/application/compute-dry-run-ok";
import type { HealthCheckReport } from "../../../../src/work/step-execution/application/run-health-checks";
import type { McpHandshakeReport } from "../../../../src/work/step-execution/application/run-work-dry-run-health-checks";

describe("computeDryRunOk", () => {
  const passingServer: McpHandshakeReport = {
    name: "fixture",
    status: "connected",
    error: undefined,
    healthy: true,
  };

  const passingCheck: HealthCheckReport = {
    name: "browser_navigate",
    resolvedId: "browser_navigate",
    severity: "required",
    outcome: { kind: "passed" },
  };

  test("true when everything is healthy, handshakes passed, and no health checks are declared", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [passingServer],
        healthChecks: [],
      }),
    ).toBe(true);
  });

  test("true when a declared health check passed", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [passingServer],
        healthChecks: [passingCheck],
      }),
    ).toBe(true);
  });

  test("treats a missing container health check (no_workspace) as healthy", () => {
    expect(
      computeDryRunOk({
        containerHealthy: undefined,
        opencodeHealthy: true,
        mcpServers: [],
        healthChecks: [],
      }),
    ).toBe(true);
  });

  test("false when the container is unhealthy", () => {
    expect(
      computeDryRunOk({
        containerHealthy: false,
        opencodeHealthy: true,
        mcpServers: [],
        healthChecks: [],
      }),
    ).toBe(false);
  });

  test("false when OpenCode itself is unhealthy", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: false,
        mcpServers: [],
        healthChecks: [],
      }),
    ).toBe(false);
  });

  test("false when a server failed its handshake", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [{ ...passingServer, healthy: false, status: "failed" }],
        healthChecks: [],
      }),
    ).toBe(false);
  });

  test("false when a declared health check failed", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [passingServer],
        healthChecks: [
          {
            ...passingCheck,
            outcome: {
              kind: "failed",
              reason: "tool-error",
              detail: "boom",
            },
          },
        ],
      }),
    ).toBe(false);
  });

  // No leniency for a declared check (#121): the user asked for it, so being
  // unable to verify it — skipped because an earlier required check aborted
  // the run — is a failure, not a benign "unverified".
  test("false when a declared health check was skipped", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [passingServer],
        healthChecks: [{ ...passingCheck, outcome: { kind: "skipped" } }],
      }),
    ).toBe(false);
  });
});
