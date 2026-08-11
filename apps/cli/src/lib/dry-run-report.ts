import type { HealthCheckReport, WorkDryRunReport } from "@boboddy/worker";
import type { BaseReporter } from "./reporter-types";

/**
 * The line plus the reporter method to render it with — a single exhaustive
 * switch over {@link HealthCheckReport.outcome}'s `kind`, so adding a new
 * outcome kind can't update the text and the severity out of lockstep.
 */
function describeHealthCheckOutcome(report: HealthCheckReport): {
  line: string;
  severity: "success" | "error" | "info" | "warn";
} {
  const label = `Health check "${report.name}" (${report.resolvedId})`;
  const outcome = report.outcome;
  switch (outcome.kind) {
    case "passed":
      return { line: `${label}: passed`, severity: "success" };
    case "failed": {
      const availableIdsSuffix =
        outcome.availableIds && outcome.availableIds.length > 0
          ? ` Available tool ids: ${outcome.availableIds.join(", ")}.`
          : "";
      return {
        line: `${label}: failed [${outcome.reason}] — ${outcome.detail}${availableIdsSuffix}`,
        severity: "error",
      };
    }
    case "skipped":
      // Never attempted because an earlier `required` check aborted the run —
      // still counts against the report's `ok`, since the user asked for it.
      return {
        line: `${label}: skipped — an earlier required health check failed first`,
        severity: "warn",
      };
  }
}

/**
 * A one-line cause for an unhealthy {@link WorkDryRunReport}, for contexts that
 * cannot render the full report — the post-push run-offer gate (#146) warns
 * with this instead of the full per-check breakdown, and persists it in the
 * marker that tells the next `pipelines design` session's orientation what
 * broke. Checked in the same order {@link renderDryRunReport} reports them, so
 * the first problem named here is the first one a full report would show too.
 */
export function summarizeDryRunFailure(report: WorkDryRunReport): string {
  if (report.launchError) {
    return `environment failed to launch: ${report.launchError}`;
  }

  const problems: string[] = [];

  if (report.containerHealth && !report.containerHealth.healthy) {
    problems.push(`container ${report.containerHealth.status}`);
  }
  if (report.opencodeHealth && !report.opencodeHealth.healthy) {
    problems.push(
      `OpenCode unhealthy${
        report.opencodeHealth.detail ? ` (${report.opencodeHealth.detail})` : ""
      }`,
    );
  }

  const unhealthyMcpServers = report.mcpServers.filter(
    (server) => !server.healthy,
  );
  if (unhealthyMcpServers.length > 0) {
    problems.push(
      `MCP server(s) unhealthy: ${unhealthyMcpServers
        .map((server) => server.name)
        .join(", ")}`,
    );
  }

  const notPassedHealthChecks = report.healthChecks.filter(
    (check) => check.outcome.kind !== "passed",
  );
  if (notPassedHealthChecks.length > 0) {
    problems.push(
      `health check(s) did not pass: ${notPassedHealthChecks
        .map((check) => check.name)
        .join(", ")}`,
    );
  }

  return problems.length > 0
    ? problems.join("; ")
    : "dry run reported unhealthy with no further detail";
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
          report.opencodeHealth.detail
            ? ` (${report.opencodeHealth.detail})`
            : ""
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
    }
  }

  if (report.healthChecks.length === 0) {
    reporter.info("Health checks: none declared");
  } else {
    for (const check of report.healthChecks) {
      const { line, severity } = describeHealthCheckOutcome(check);
      reporter[severity](line);
    }
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
