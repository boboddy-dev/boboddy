import {
  probeReadiness,
  READINESS_PATH,
  type OpencodeServerHandle,
} from "../../../runtime/runtime-service/infra/opencode-server-contract";

/** Timeout for the standalone readiness re-check used in the report. */
const OPENCODE_HEALTH_CHECK_TIMEOUT_MS = 5_000;

// Re-exported so existing imports from this dry-run-named module keep
// working. `pollMcpStatus` itself is a shared utility, not dry-run-specific
// — a real task run calls it too, as a warm-up inside `runHealthChecks()`
// (see `run-health-checks.ts`).
export { pollMcpStatus, type McpHandshakeReport } from "./poll-mcp-status";

/**
 * A fresh authenticated readiness probe, independent of the one `launch()`
 * already did at startup. Healthy only when the server answers with the
 * version it was launched as.
 */
export async function checkOpencodeHealth(
  server: OpencodeServerHandle,
  expectedVersion: string,
): Promise<{ healthy: boolean; detail?: string | undefined }> {
  const result = await probeReadiness({
    baseUrl: server.baseUrl,
    password: server.password,
    expectedVersion,
    signal: AbortSignal.timeout(OPENCODE_HEALTH_CHECK_TIMEOUT_MS),
  });
  switch (result.kind) {
    case "ready":
      return { healthy: true };
    case "wrong-version":
      return {
        healthy: false,
        detail: `${READINESS_PATH} reports version ${result.version}, expected ${expectedVersion}`,
      };
    case "not-yet":
      return { healthy: false, detail: result.reason };
  }
}
