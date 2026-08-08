import type { HealthCheckReport } from "./run-health-checks";
import type { McpHandshakeReport } from "./run-work-dry-run-health-checks";

/**
 * True only when container + OpenCode health are both fine, every MCP server
 * passed its handshake, and every declared health check {@link
 * HealthCheckReport.outcome} came back `passed`.
 *
 * No leniency for declared checks (#121): `failed` and `skipped` both count
 * against the run, exactly like an outright failure — the user asked for the
 * check, so being unable to verify it is not success. This replaces the
 * dry-run-only per-server "benignly unverified" carve-out the deleted
 * `mcp-canary-registry.ts` needed; declared checks have no such carve-out.
 */
export function computeDryRunOk(input: {
  containerHealthy: boolean | undefined;
  opencodeHealthy: boolean;
  mcpServers: McpHandshakeReport[];
  healthChecks: HealthCheckReport[];
}): boolean {
  return (
    (input.containerHealthy ?? true) &&
    input.opencodeHealthy &&
    input.mcpServers.every((server) => server.healthy) &&
    input.healthChecks.every((report) => report.outcome.kind === "passed")
  );
}
