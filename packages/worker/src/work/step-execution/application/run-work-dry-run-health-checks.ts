import { createOpencodeClient, type McpStatus } from "@opencode-ai/sdk";
import { logWorkError } from "./work-logger";

/** How long to keep polling `client.mcp.status()` before settling on a report. */
const MCP_STATUS_POLL_WINDOW_MS = 10_000;
const MCP_STATUS_POLL_INTERVAL_MS = 500;
/** Timeout for the standalone `/global/health` re-check used in the report. */
const OPENCODE_HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * The MCP handshake-only view of a server: whatever `client.mcp.status()`
 * reports. This is also the dry-run report's whole per-server shape
 * ({@link WorkDryRunReport.mcpServers} in `run-work-dry-run.ts`) — as of
 * #121, per-server entries report handshake status only. A server's declared
 * health checks (if any) are reported separately, in the report's top-level
 * `healthChecks` array, alongside plugin- and standalone-tool checks that
 * have no server to nest under.
 */
export type McpHandshakeReport = {
  name: string;
  status: McpStatus["status"];
  error?: string | undefined;
  /** `connected`, or `disabled` (intentionally turned off), count as healthy. */
  healthy: boolean;
};

/**
 * Poll `client.mcp.status()` for a short window rather than trusting a single
 * read: a slow-starting MCP server (e.g. an `npx`-installed one) can race a
 * read taken immediately after OpenCode reports healthy. Stops early once two
 * consecutive polls agree, otherwise returns whatever the last poll saw when
 * the window elapses.
 */
export async function pollMcpStatus(
  agentBaseUrl: string,
  workspaceFolder: string,
  options?: { windowMs?: number; intervalMs?: number },
): Promise<McpHandshakeReport[]> {
  const client = createOpencodeClient({
    baseUrl: agentBaseUrl,
    directory: workspaceFolder,
  });
  const windowMs = options?.windowMs ?? MCP_STATUS_POLL_WINDOW_MS;
  const intervalMs = options?.intervalMs ?? MCP_STATUS_POLL_INTERVAL_MS;
  const deadline = Date.now() + windowMs;
  let previous: Record<string, McpStatus> | null = null;

  for (;;) {
    let current: Record<string, McpStatus> = {};
    try {
      const response = await client.mcp.status();
      current = response.data ?? {};
    } catch (error) {
      logWorkError("dry-run", "Failed to read MCP status", {
        agentBaseUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const stable =
      previous !== null && JSON.stringify(previous) === JSON.stringify(current);
    const timedOut = Date.now() >= deadline;

    if (stable || timedOut) {
      return Object.entries(current)
        .map(([name, status]) => ({
          name,
          status: status.status,
          error: "error" in status ? status.error : undefined,
          healthy:
            status.status === "connected" || status.status === "disabled",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    previous = current;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

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
