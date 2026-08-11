import { describe, expect, test } from "bun:test";
import type {
  HealthCheckReport,
  McpHandshakeReport,
  WorkDryRunReport,
} from "@boboddy/worker";
import {
  renderDryRunReport,
  summarizeDryRunFailure,
} from "../src/lib/dry-run-report";
import type { BaseReporter } from "../src/lib/reporter-types";

function createSpyReporter(calls: string[]): BaseReporter {
  return {
    start: () => {},
    finish: () => {},
    startTask: () => ({ update: () => {}, succeed: () => {}, fail: () => {} }),
    info: (m) => calls.push(`info:${m}`),
    success: (m) => calls.push(`success:${m}`),
    warn: (m) => calls.push(`warn:${m}`),
    error: (m) => calls.push(`error:${m}`),
  };
}

function connected(
  name: string,
  overrides: Partial<McpHandshakeReport> = {},
): McpHandshakeReport {
  return {
    name,
    status: "connected",
    error: undefined,
    healthy: true,
    ...overrides,
  };
}

function healthCheckReport(
  overrides: Partial<HealthCheckReport> & {
    outcome: HealthCheckReport["outcome"];
  },
): HealthCheckReport {
  return {
    name: overrides.name ?? "browser_navigate",
    resolvedId: overrides.resolvedId ?? "browser_navigate",
    severity: overrides.severity ?? "required",
    outcome: overrides.outcome,
  };
}

function reportWith(input: {
  mcpServers?: McpHandshakeReport[];
  healthChecks?: HealthCheckReport[];
}): WorkDryRunReport {
  return {
    ok: false,
    scope: { kind: "global-only" },
    workspacePath: null,
    runtimeContainerId: null,
    agentBaseUrl: null,
    kept: false,
    containerHealth: null,
    opencodeHealth: null,
    providerCredentials: { ok: true, detail: "resolved" },
    mcpServers: input.mcpServers ?? [],
    healthChecks: input.healthChecks ?? [],
  };
}

function render(input: {
  mcpServers?: McpHandshakeReport[];
  healthChecks?: HealthCheckReport[];
}): string[] {
  const calls: string[] = [];
  renderDryRunReport(reportWith(input), createSpyReporter(calls));
  return calls;
}

describe("renderDryRunReport", () => {
  test("per-server lines report handshake status only", () => {
    const lines = render({
      mcpServers: [
        connected("postgres"),
        connected("playwright", {
          status: "failed",
          healthy: false,
          error: "boom",
        }),
      ],
    });

    expect(lines).toEqual([
      "info:Scope: global-only — no step MCP overrides injected",
      "success:Provider credentials: resolved",
      "success:MCP postgres: connected",
      "error:MCP playwright: failed — boom",
      "info:Health checks: none declared",
    ]);
  });

  test("reports 'MCP servers: none configured' when there are none", () => {
    const lines = render({});
    expect(lines).toContain("info:MCP servers: none configured");
  });

  test("renders a passed health check as success", () => {
    const lines = render({
      healthChecks: [
        healthCheckReport({
          name: "browser_navigate",
          resolvedId: "browser_navigate",
          outcome: { kind: "passed" },
        }),
      ],
    });

    expect(lines).toContain(
      'success:Health check "browser_navigate" (browser_navigate): passed',
    );
  });

  test("renders a failed health check with reason, detail, and available ids", () => {
    const lines = render({
      healthChecks: [
        healthCheckReport({
          name: "not_a_real_tool",
          resolvedId: "not_a_real_tool",
          outcome: {
            kind: "failed",
            reason: "not-registered",
            detail:
              'Tool "not_a_real_tool" is not registered in this environment.',
            availableIds: ["browser_navigate", "list_schemas"],
          },
        }),
      ],
    });

    expect(lines).toContain(
      'error:Health check "not_a_real_tool" (not_a_real_tool): failed [not-registered] — ' +
        'Tool "not_a_real_tool" is not registered in this environment. ' +
        "Available tool ids: browser_navigate, list_schemas.",
    );
  });

  test("renders a skipped health check as a warning", () => {
    const lines = render({
      healthChecks: [
        healthCheckReport({
          name: "list_schemas",
          resolvedId: "postgres_list_schemas",
          outcome: { kind: "skipped" },
        }),
      ],
    });

    expect(lines).toContain(
      'warn:Health check "list_schemas" (postgres_list_schemas): skipped — an ' +
        "earlier required health check failed first",
    );
  });

  test("reports 'Health checks: none declared' when the step declares none", () => {
    const lines = render({});
    expect(lines).toContain("info:Health checks: none declared");
  });
});

describe("summarizeDryRunFailure", () => {
  test("names a launch error above everything else", () => {
    const report: WorkDryRunReport = {
      ...reportWith({}),
      launchError: "devcontainer build failed: exit 1",
    };

    expect(summarizeDryRunFailure(report)).toBe(
      "environment failed to launch: devcontainer build failed: exit 1",
    );
  });

  test("names an unhealthy container", () => {
    const report: WorkDryRunReport = {
      ...reportWith({}),
      containerHealth: { status: "exited", healthy: false },
    };

    expect(summarizeDryRunFailure(report)).toBe("container exited");
  });

  test("names unhealthy OpenCode with its detail", () => {
    const report: WorkDryRunReport = {
      ...reportWith({}),
      opencodeHealth: { healthy: false, detail: "connection refused" },
    };

    expect(summarizeDryRunFailure(report)).toBe(
      "OpenCode unhealthy (connection refused)",
    );
  });

  test("names every unhealthy MCP server", () => {
    const report = reportWith({
      mcpServers: [
        connected("postgres"),
        connected("playwright", { status: "failed", healthy: false }),
      ],
    });

    expect(summarizeDryRunFailure(report)).toBe(
      "MCP server(s) unhealthy: playwright",
    );
  });

  test("names every health check that did not pass", () => {
    const report = reportWith({
      healthChecks: [
        healthCheckReport({
          name: "browser_navigate",
          outcome: { kind: "passed" },
        }),
        healthCheckReport({
          name: "not_a_real_tool",
          outcome: {
            kind: "failed",
            reason: "not-registered",
            detail: "not registered",
          },
        }),
      ],
    });

    expect(summarizeDryRunFailure(report)).toBe(
      "health check(s) did not pass: not_a_real_tool",
    );
  });

  test("combines multiple problems", () => {
    const report: WorkDryRunReport = {
      ...reportWith({
        mcpServers: [
          connected("postgres", { status: "failed", healthy: false }),
        ],
      }),
      containerHealth: { status: "exited", healthy: false },
    };

    expect(summarizeDryRunFailure(report)).toBe(
      "container exited; MCP server(s) unhealthy: postgres",
    );
  });

  test("falls back to a generic line when nothing specific is unhealthy", () => {
    expect(summarizeDryRunFailure(reportWith({}))).toBe(
      "dry run reported unhealthy with no further detail",
    );
  });
});
