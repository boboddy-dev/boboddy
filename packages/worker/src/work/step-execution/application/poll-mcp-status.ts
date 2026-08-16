import { createOpencodeClient, type McpStatus } from "@opencode-ai/sdk";
import { logWorkError } from "./work-logger";

/** How long to keep polling `client.mcp.status()` before settling on a report. */
const MCP_STATUS_POLL_WINDOW_MS = 10_000;
const MCP_STATUS_POLL_INTERVAL_MS = 500;

/**
 * The MCP handshake-only view of a server: whatever `client.mcp.status()`
 * reports. This is the dry-run report's whole per-server shape
 * ({@link WorkDryRunReport.mcpServers} in `run-work-dry-run.ts`) — as of
 * #121, per-server entries report handshake status only. A server's declared
 * health checks (if any) are reported separately, in the report's top-level
 * `healthChecks` array, alongside plugin- and standalone-tool checks that
 * have no server to nest under. `pollMcpStatus` returns this same shape when
 * called from `runHealthChecks()`'s warm-up during real step execution too;
 * only dry run surfaces it as a report field today.
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
 * the window elapses. Shared by `work --dry-run` (`run-work-dry-run.ts`,
 * to build its report) and real step execution (`runHealthChecks()`'s
 * warm-up before the first declared check forces a tool call) — this poll
 * itself is not specific to either flow.
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
