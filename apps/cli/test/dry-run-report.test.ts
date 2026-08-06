import { describe, expect, test } from "bun:test";
import type { WorkDryRunMcpServerReport, WorkDryRunReport } from "@boboddy/worker";
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
  canary: WorkDryRunMcpServerReport["canary"],
): WorkDryRunMcpServerReport {
  return { name, status: "connected", error: undefined, healthy: true, canary };
}

function reportWith(mcpServers: WorkDryRunMcpServerReport[]): WorkDryRunReport {
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
    mcpServers,
  };
}

function render(mcpServers: WorkDryRunMcpServerReport[]): string[] {
  const calls: string[] = [];
  renderDryRunReport(reportWith(mcpServers), createSpyReporter(calls));
  return calls;
}

const AUTH_DETAIL =
  "UnknownError: Claude Code credentials are unavailable or expired.";

describe("renderDryRunReport canary lines", () => {
  test("blames the harness once, not every skipped server", () => {
    const lines = render([
      connected("postgres", {
        kind: "ran-and-failed",
        reason: "session-error",
        detail: AUTH_DETAIL,
      }),
      connected("playwright", { kind: "unverified", reason: "harness-unavailable" }),
      connected("browser", { kind: "unverified", reason: "harness-unavailable" }),
    ]);

    expect(lines).toEqual([
      "info:Scope: global-only — no step MCP overrides injected",
      "success:Provider credentials: resolved",
      "success:MCP postgres: connected",
      `error:MCP postgres canary: failed (session-error) — ${AUTH_DETAIL}`,
      "success:MCP playwright: connected",
      "warn:MCP playwright canary: unverified (harness-unavailable) — the AI harness " +
        "failed, so this canary never ran; see the failed canary above for the cause",
      "success:MCP browser: connected",
      "warn:MCP browser canary: unverified (harness-unavailable) — the AI harness " +
        "failed, so this canary never ran; see the failed canary above for the cause",
      "error:AI harness unavailable — 2 MCP canaries were skipped; see the failed " +
        "canary above for the cause",
    ]);
    // Exactly one line carries the underlying cause.
    expect(lines.filter((line) => line.includes(AUTH_DETAIL))).toHaveLength(1);
  });

  test("uses singular wording for a single skipped canary", () => {
    const lines = render([
      connected("postgres", {
        kind: "ran-and-failed",
        reason: "session-error",
        detail: AUTH_DETAIL,
      }),
      connected("playwright", { kind: "unverified", reason: "harness-unavailable" }),
    ]);

    expect(lines).toContain(
      "error:AI harness unavailable — 1 MCP canary was skipped; see the failed " +
        "canary above for the cause",
    );
  });

  test("adds no top-level harness line when nothing was skipped", () => {
    const lines = render([
      connected("postgres", { kind: "ran-and-passed" }),
      connected("playwright", { kind: "unverified", reason: "no-match" }),
    ]);

    expect(lines).toEqual([
      "info:Scope: global-only — no step MCP overrides injected",
      "success:Provider credentials: resolved",
      "success:MCP postgres: connected",
      "success:MCP postgres canary: passed",
      "success:MCP playwright: connected",
      "info:MCP playwright canary: unverified (no-match)",
    ]);
  });
});
