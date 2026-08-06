import type { McpCanaryOutcome, WorkDryRunReport } from "@boboddy/worker";
import type { BaseReporter } from "./reporter-types";

/**
 * The line plus the reporter method to render it with — a single switch, so
 * adding a new {@link McpCanaryOutcome} kind can't update the text and the
 * severity out of lockstep.
 */
function describeCanaryOutcome(
  serverName: string,
  canary: McpCanaryOutcome,
): { line: string; severity: "success" | "error" | "info" | "warn" } {
  switch (canary.kind) {
    case "ran-and-passed":
      return { line: `MCP ${serverName} canary: passed`, severity: "success" };
    case "ran-and-failed":
      return {
        line: `MCP ${serverName} canary: failed (${canary.reason}) — ${canary.detail}`,
        severity: "error",
      };
    case "unverified":
      // `harness-unavailable` isn't a verdict about this server at all: the AI
      // harness died on an earlier canary, so this one never ran. Warn rather
      // than info, because it counts against the report's `ok`.
      return canary.reason === "harness-unavailable"
        ? {
            line:
              `MCP ${serverName} canary: unverified (harness-unavailable) — the AI ` +
              "harness failed, so this canary never ran; see the failed canary above " +
              "for the cause",
            severity: "warn",
          }
        : {
            line: `MCP ${serverName} canary: unverified (${canary.reason})`,
            severity: "info",
          };
  }
}

/**
 * The single top-level line for a harness failure, or `undefined` when the
 * harness held up. Derived from the per-server outcomes rather than carried as
 * its own report field — `harness-unavailable` exists only because some canary
 * hit a `session-error`, so the report already says everything needed.
 */
function describeHarnessFailure(
  mcpServers: WorkDryRunReport["mcpServers"],
): string | undefined {
  const skipped = mcpServers.filter(
    (server) =>
      server.canary.kind === "unverified" &&
      server.canary.reason === "harness-unavailable",
  ).length;

  if (skipped === 0) {
    return undefined;
  }

  return (
    `AI harness unavailable — ${String(skipped)} MCP ` +
    `${skipped === 1 ? "canary was" : "canaries were"} skipped; ` +
    "see the failed canary above for the cause"
  );
}

/**
 * Render a {@link WorkDryRunReport} through the CLI's reporter. Mirrors the
 * severity the report already computed per line (success/warn/error) rather
 * than re-deriving it, so the terminal output and the `ok` exit-code decision
 * in `run-work-dry-run.ts` can never disagree.
 */
export function renderDryRunReport(
  report: WorkDryRunReport,
  reporter: BaseReporter,
): void {
  reporter.info(
    report.scope.kind === "step"
      ? `Step: ${report.scope.stepDefinitionName} (${report.scope.stepDefinitionKey})`
      : "Scope: global-only — no step MCP overrides injected",
  );

  if (report.launchError) {
    reporter.error(`Environment failed to launch: ${report.launchError}`);
    return;
  }

  if (report.containerHealth) {
    const line = `Container: ${report.containerHealth.status}`;
    if (report.containerHealth.healthy) {
      reporter.success(line);
    } else {
      reporter.error(line);
    }
  }

  if (report.opencodeHealth) {
    const line = report.opencodeHealth.healthy
      ? "OpenCode: healthy"
      : `OpenCode: unhealthy${
          report.opencodeHealth.detail ? ` (${report.opencodeHealth.detail})` : ""
        }`;
    if (report.opencodeHealth.healthy) {
      reporter.success(line);
    } else {
      reporter.error(line);
    }
  }

  const providerLine = `Provider credentials: ${report.providerCredentials.detail}`;
  if (report.providerCredentials.ok) {
    reporter.success(providerLine);
  } else {
    reporter.warn(providerLine);
  }

  if (report.mcpServers.length === 0) {
    reporter.info("MCP servers: none configured");
  } else {
    for (const server of report.mcpServers) {
      const line = `MCP ${server.name}: ${server.status}${
        server.error ? ` — ${server.error}` : ""
      }`;
      if (server.healthy) {
        reporter.success(line);
      } else {
        reporter.error(line);
      }

      const canary = describeCanaryOutcome(server.name, server.canary);
      reporter[canary.severity](canary.line);
    }
  }

  const harnessFailure = describeHarnessFailure(report.mcpServers);
  if (harnessFailure) {
    reporter.error(harnessFailure);
  }

  if (report.kept) {
    reporter.info(
      "Preserved for debugging — " +
        `container: ${report.runtimeContainerId ?? "n/a"}, ` +
        `workspace: ${report.workspacePath ?? "n/a"}, ` +
        `agent: ${report.agentBaseUrl ?? "n/a"}`,
    );
  }
}
