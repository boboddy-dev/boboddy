import { describe, expect, test } from "bun:test";
import type {
  HealthCheckReport,
  McpHandshakeReport,
  WorkDryRunReport,
} from "@boboddy/worker";
import { renderDryRunReport } from "../src/lib/dry-run-report";
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
