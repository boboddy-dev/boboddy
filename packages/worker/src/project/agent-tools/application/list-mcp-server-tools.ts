import type { DiscoveredMcpServer } from "../domain/discovered-agent-tools";
import {
  missingRequiredEnv,
  type ListedMcpTool,
  type McpServerAvailability,
} from "../domain/agent-tools-manifest";

/**
 * Lists every discovered MCP server's tools by starting it on the host, for
 * the pipeline designer (D14). Never throws: a server missing a `requiredEnv`
 * variable is not started, and one that fails or exceeds the timeout is
 * recorded with the reason.
 *
 * Servers are listed concurrently. Starting each one is the
 * {@link McpToolLister}'s job, so this is testable without real processes.
 */

export const DEFAULT_MCP_TOOL_LISTING_TIMEOUT_MS = 15_000;

/** Starts one server, lists its tools and stops it again. */
export interface McpToolLister {
  /**
   * Must stop the server before settling, including when `signal` aborts.
   * `env` holds the values every `{env:VAR}` in the definition resolves from.
   */
  listTools(input: {
    server: DiscoveredMcpServer;
    env: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }): Promise<ListedMcpTool[]>;
}

export type McpServerToolListing = {
  availability: McpServerAvailability;
  tools: ListedMcpTool[];
};

export async function listMcpServerTools(input: {
  servers: readonly DiscoveredMcpServer[];
  env: Readonly<Record<string, string>>;
  lister: McpToolLister;
  timeoutMs?: number;
}): Promise<Map<string, McpServerToolListing>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_MCP_TOOL_LISTING_TIMEOUT_MS;
  const entries = await Promise.all(
    input.servers.map(
      async (server) =>
        [
          server.name,
          await listOne({
            server,
            env: input.env,
            lister: input.lister,
            timeoutMs,
          }),
        ] as const,
    ),
  );
  return new Map(entries);
}

async function listOne(input: {
  server: DiscoveredMcpServer;
  env: Readonly<Record<string, string>>;
  lister: McpToolLister;
  timeoutMs: number;
}): Promise<McpServerToolListing> {
  const { server, env } = input;
  const missing = missingRequiredEnv(server, env);
  if (missing.length > 0) {
    return {
      availability: {
        status: "unavailable",
        reason: `missing ${missing.join(", ")}`,
      },
      tools: [],
    };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, input.timeoutMs);
  });
  const listing = input.lister.listTools({
    server,
    env,
    signal: controller.signal,
  });

  try {
    const result = await Promise.race([listing, timedOut]);
    if (result === "timeout") {
      controller.abort();
      await listing.catch(() => undefined);
      return {
        availability: {
          status: "failed",
          reason: `timed out after ${String(input.timeoutMs / 1000)}s`,
        },
        tools: [],
      };
    }
    return { availability: { status: "available" }, tools: result };
  } catch (error) {
    return {
      availability: {
        status: "failed",
        reason: redactEnvValues(
          error instanceof Error ? error.message : String(error),
          server,
          env,
        ),
      },
      tools: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An error message can echo a resolved URL or argument; put the
 * placeholders back so no value reaches the manifest.
 */
function redactEnvValues(
  message: string,
  server: DiscoveredMcpServer,
  env: Readonly<Record<string, string>>,
): string {
  let redacted = message;
  for (const name of server.requiredEnv) {
    const value = env[name];
    if (value !== undefined && value.length >= 4) {
      redacted = redacted.replaceAll(value, `{env:${name}}`);
    }
  }
  return redacted;
}
