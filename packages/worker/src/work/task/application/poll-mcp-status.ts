import type { McpServer } from "@opencode/client";
import { logWorkError } from "./work-logger";
import {
  createBoboddyOpencodeClient,
  opencodeLocation,
} from "../infra/opencode-client";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";

/**
 * How long to keep polling `client.mcp.list()` before settling on a report.
 * Sized for cold `uvx`/`npx` installs, which routinely take 5–15s to connect.
 */
const MCP_STATUS_POLL_WINDOW_MS = 60_000;
const MCP_STATUS_POLL_INTERVAL_MS = 500;

/** An MCP server's connection status as reported by OpenCode's `GET /api/mcp`. */
export type McpConnectionStatus = McpServer["status"]["status"];

/**
 * The MCP handshake-only view of a server: whatever `client.mcp.list()`
 * reports. This is the dry-run report's whole per-server shape
 * ({@link WorkDryRunReport.mcpServers} in `run-work-dry-run.ts`) — as of
 * #121, per-server entries report handshake status only. A server's declared
 * health checks (if any) are reported separately, in the report's top-level
 * `healthChecks` array, alongside plugin- and standalone-tool checks that
 * have no server to nest under. `pollMcpStatus` returns this same shape when
 * called from `runHealthChecks()`'s warm-up during a real task run too;
 * only dry run surfaces it as a report field today.
 */
export type McpHandshakeReport = {
  name: string;
  status: McpConnectionStatus;
  error?: string | undefined;
  /** `connected`, or `disabled` (intentionally turned off), count as healthy. */
  healthy: boolean;
};

/**
 * Poll `client.mcp.list()` for a short window rather than trusting a single
 * read: a slow-starting MCP server (e.g. an `npx`-installed one) can race a
 * read taken immediately after OpenCode reports healthy. Stops early once no
 * server is still `pending` and two consecutive polls agree, otherwise
 * returns whatever the last poll saw when the window elapses. A server stuck
 * in `pending` across consecutive polls is still connecting, not settled —
 * treating that as stable let health checks race slow servers. Likewise, a
 * server named in `expectedServers` that is not listed yet has not been
 * registered: right after boot OpenCode can report an empty list for a
 * moment, and two empty reads must not count as settled. Shared by `work --dry-run` (`run-work-dry-run.ts`,
 * to build its report) and a real task run (`runHealthChecks()`'s
 * warm-up before the first declared check forces a tool call) — this poll
 * itself is not specific to either flow.
 */
export async function pollMcpStatus(
  server: OpencodeServerHandle,
  options?: {
    windowMs?: number;
    intervalMs?: number;
    expectedServers?: readonly string[];
  },
): Promise<McpHandshakeReport[]> {
  const client = createBoboddyOpencodeClient(server);
  const windowMs = options?.windowMs ?? MCP_STATUS_POLL_WINDOW_MS;
  const intervalMs = options?.intervalMs ?? MCP_STATUS_POLL_INTERVAL_MS;
  const expectedServers = options?.expectedServers ?? [];
  const deadline = Date.now() + windowMs;
  let previous: McpServer[] | null = null;

  for (;;) {
    let current: McpServer[] = [];
    try {
      const response = await client.mcp.list({
        location: opencodeLocation(server),
      });
      current = response.data;
    } catch (error) {
      logWorkError("dry-run", "Failed to read MCP status", {
        agentBaseUrl: server.baseUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const settled =
      current.every(({ status }) => status.status !== "pending") &&
      expectedServers.every((name) =>
        current.some((entry) => entry.name === name),
      );
    const stable =
      settled &&
      previous !== null &&
      JSON.stringify(previous) === JSON.stringify(current);
    const timedOut = Date.now() >= deadline;

    if (stable || timedOut) {
      return current
        .map(({ name, status }) => ({
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
