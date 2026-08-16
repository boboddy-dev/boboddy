/** Timeout for the standalone `/global/health` re-check used in the report. */
const OPENCODE_HEALTH_CHECK_TIMEOUT_MS = 5_000;

// Re-exported so existing imports from this dry-run-named module keep
// working. `pollMcpStatus` itself is a shared utility, not dry-run-specific
// — real step execution calls it too, as a warm-up inside `runHealthChecks()`
// (see `run-health-checks.ts`).
export { pollMcpStatus, type McpHandshakeReport } from "./poll-mcp-status";

/** A fresh re-check of `/global/health`, independent of the one `launch()` already did at startup. */
export async function checkOpencodeHealth(
  agentBaseUrl: string,
): Promise<{ healthy: boolean; detail?: string | undefined }> {
  try {
    const response = await fetch(`${agentBaseUrl}/global/health`, {
      signal: AbortSignal.timeout(OPENCODE_HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok
      ? { healthy: true }
      : { healthy: false, detail: `HTTP ${String(response.status)}` };
  } catch (error) {
    return {
      healthy: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
