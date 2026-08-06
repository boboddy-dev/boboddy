import { describe, expect, test } from "bun:test";
import {
  computeDryRunOk,
  type WorkDryRunMcpServerReport,
} from "../../../../src/work/step-execution/application/run-work-dry-run-mcp-canaries";

describe("computeDryRunOk", () => {
  const passingServer: WorkDryRunMcpServerReport = {
    name: "fixture",
    status: "connected",
    error: undefined,
    healthy: true,
    canary: { kind: "ran-and-passed" },
  };

  test("true when everything is healthy and no canary failed", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [passingServer],
      }),
    ).toBe(true);
  });

  test("treats a missing container health check (no_workspace) as healthy", () => {
    expect(
      computeDryRunOk({
        containerHealthy: undefined,
        opencodeHealthy: true,
        mcpServers: [],
      }),
    ).toBe(true);
  });

  test("false when the container is unhealthy", () => {
    expect(
      computeDryRunOk({
        containerHealthy: false,
        opencodeHealthy: true,
        mcpServers: [],
      }),
    ).toBe(false);
  });

  test("false when OpenCode itself is unhealthy", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: false,
        mcpServers: [],
      }),
    ).toBe(false);
  });

  test("false when a server failed its handshake", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [{ ...passingServer, healthy: false, status: "failed" }],
      }),
    ).toBe(false);
  });

  test("false when a server's canary actually ran and failed", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [
          {
            ...passingServer,
            canary: { kind: "ran-and-failed", reason: "tool-error", detail: "boom" },
          },
        ],
      }),
    ).toBe(false);
  });

  test.each(["no-match", "ambiguous-match", "not-connected", "not-local"] as const)(
    "true when a server's canary is benignly unverified (%s)",
    (reason) => {
      expect(
        computeDryRunOk({
          containerHealthy: true,
          opencodeHealthy: true,
          mcpServers: [{ ...passingServer, canary: { kind: "unverified", reason } }],
        }),
      ).toBe(true);
    },
  );

  // Unlike the reasons above, this one means verification was owed and the AI
  // harness died before we could do it — "ok" would be a claim we never tested.
  test("false when a canary was skipped because the harness was unavailable", () => {
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        mcpServers: [
          {
            ...passingServer,
            canary: { kind: "unverified", reason: "harness-unavailable" },
          },
        ],
      }),
    ).toBe(false);
  });
});
