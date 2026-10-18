import { describe, expect, test } from "bun:test";
import type {
  HealthCheckReport,
  McpHandshakeReport,
  PipelineHealthDryRunReport,
  StepHealthCheckReport,
  WorkDryRunReport,
} from "@boboddy/worker";
import {
  renderDryRunReport,
  toDryRunGateResult,
} from "../src/lib/dry-run-report";
import type { BaseReporter } from "../src/lib/reporter-types";

function createSpyReporter(calls: string[]): BaseReporter {
  return {
    start: () => {},
    finish: () => {},
    startActivity: () => ({
      update: () => {},
      succeed: () => {},
      fail: () => {},
    }),
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
    kind: overrides.kind ?? "tool",
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

  test("renders a passed cli health check as success", () => {
    const lines = render({
      healthChecks: [
        healthCheckReport({
          name: "gh --version",
          resolvedId: "gh --version",
          kind: "cli",
          outcome: { kind: "passed" },
        }),
      ],
    });

    expect(lines).toContain(
      'success:Health check "gh --version" (gh --version): passed',
    );
  });

  test("renders a failed cli health check with a nonzero-exit reason and detail", () => {
    const lines = render({
      healthChecks: [
        healthCheckReport({
          name: "gh --version",
          resolvedId: "gh --version",
          kind: "cli",
          outcome: {
            kind: "failed",
            reason: "nonzero-exit",
            detail:
              "Command exited with 127, expected 0. Output: bash: gh: command not found",
          },
        }),
      ],
    });

    expect(lines).toContain(
      'error:Health check "gh --version" (gh --version): failed [nonzero-exit] — ' +
        "Command exited with 127, expected 0. Output: bash: gh: command not found",
    );
  });

  test("renders a skipped cli health check as a warning", () => {
    const lines = render({
      healthChecks: [
        healthCheckReport({
          name: "gh --version",
          resolvedId: "gh --version",
          kind: "cli",
          outcome: { kind: "skipped" },
        }),
      ],
    });

    expect(lines).toContain(
      'warn:Health check "gh --version" (gh --version): skipped — an ' +
        "earlier required health check failed first",
    );
  });

  test("renders a mixed tool + cli report with both formats coexisting legibly", () => {
    const lines = render({
      healthChecks: [
        healthCheckReport({
          name: "browser_navigate",
          resolvedId: "browser_navigate",
          kind: "tool",
          outcome: { kind: "passed" },
        }),
        healthCheckReport({
          name: "gh --version",
          resolvedId: "gh --version",
          kind: "cli",
          outcome: {
            kind: "failed",
            reason: "nonzero-exit",
            detail: "Command exited with 127, expected 0. Output: not found",
          },
        }),
      ],
    });

    expect(lines).toEqual([
      "info:Scope: global-only — no step MCP overrides injected",
      "success:Provider credentials: resolved",
      "info:MCP servers: none configured",
      'success:Health check "browser_navigate" (browser_navigate): passed',
      'error:Health check "gh --version" (gh --version): failed [nonzero-exit] — ' +
        "Command exited with 127, expected 0. Output: not found",
    ]);
  });
});

describe("toDryRunGateResult", () => {
  const stepReport = (
    overrides: Partial<StepHealthCheckReport>,
  ): StepHealthCheckReport => ({
    stepDefinitionId: "id",
    stepKey: "fix",
    stepName: "Fix",
    runtime: "project devcontainer",
    launchError: null,
    environmentProblems: [],
    mcpServers: [],
    healthChecks: [],
    ...overrides,
  });

  const gateReport = (
    steps: StepHealthCheckReport[],
    ok: boolean,
  ): PipelineHealthDryRunReport => ({
    ok,
    pipelineDefinitionId: "pipeline-1",
    launchCount: 1,
    steps,
    stepsWithoutChecks: [],
  });

  test("reports each step's checks and summarizes only the blocking ones", () => {
    const result = toDryRunGateResult(
      gateReport(
        [
          stepReport({
            stepName: "Investigate",
            healthChecks: [
              healthCheckReport({
                name: "browser",
                outcome: { kind: "passed" },
              }),
              healthCheckReport({
                name: "playwright-cli",
                severity: "warn",
                outcome: {
                  kind: "failed",
                  reason: "nonzero-exit",
                  detail: "missing",
                },
              }),
            ],
          }),
          stepReport({
            stepName: "Fix",
            healthChecks: [
              healthCheckReport({
                name: "test-runner",
                outcome: {
                  kind: "failed",
                  reason: "nonzero-exit",
                  detail: "vitest: not found",
                },
              }),
            ],
          }),
        ],
        false,
      ),
    );

    expect(result.ok).toBe(false);
    expect(
      result.findings.map((finding) => [
        finding.stepName,
        finding.checkName,
        finding.passed,
        finding.blocking,
      ]),
    ).toEqual([
      ["Investigate", "browser", true, false],
      ["Investigate", "playwright-cli", false, false],
      ["Fix", "test-runner", false, true],
    ]);
    expect(result.summary).toBe(
      "Fix › test-runner (required): [nonzero-exit] vitest: not found",
    );
  });

  test("says so when no step declares a check", () => {
    expect(toDryRunGateResult(gateReport([], true))).toEqual({
      ok: true,
      summary: "no step declares health checks",
      findings: [],
    });
  });
});
