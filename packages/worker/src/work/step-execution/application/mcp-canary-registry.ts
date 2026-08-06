import type { OpenCodeMcpServerConfig } from "../../../common/contracts/opencode-mcp";
import { logWorkError } from "./work-logger";

/** Where users are pointed when the registry produces an ambiguous match. */
export const MCP_CANARY_ISSUE_URL =
  "https://github.com/boboddy-dev/boboddy/issues/new";

/**
 * Which part of a `local` MCP server's config a matcher is tested against:
 * - `name` — the server's config-key name (e.g. `postgres`).
 * - `args` — the server's `command` array joined with spaces
 *   (e.g. `npx -y @playwright/mcp@latest --headless`).
 */
export type McpCanaryMatcherField = "name" | "args";

/**
 * Exactly one field per matcher. A server that needs to be caught two different
 * ways gets two registry entries, not one entry with a combined pattern — that
 * keeps ambiguity detection meaningful.
 */
export type McpCanaryMatcher = {
  field: McpCanaryMatcherField;
  pattern: RegExp;
};

/**
 * The tool call a registry entry declares, with `tool` **bare** (unqualified).
 * Bare because MCP tool names are qualified with the matched server's config-key
 * name, which isn't known until the matcher runs.
 */
export type McpCanarySpec = {
  tool: string;
  args: Record<string, unknown>;
};

/**
 * A callable MCP tool call, with `tool` already qualified as
 * `${serverName}_${toolName}`. Calling this and getting no error is what proves
 * a server actually works, rather than only that it completed the handshake.
 */
export type McpCanaryCall = {
  tool: string;
  args: Record<string, unknown>;
};

export type McpCanaryRegistryEntry = {
  /** Stable identifier, used in reports and ambiguity diagnostics. */
  id: string;
  matcher: McpCanaryMatcher;
  canary: McpCanarySpec;
};

export type McpCanaryUnverifiedReason =
  /** No registry entry knows a canary call for this server. */
  | "no-match"
  /** Two or more registry entries claimed this server; the registry needs fixing. */
  | "ambiguous-match";

export type McpCanaryMatch =
  | { kind: "matched"; entryId: string; canary: McpCanaryCall }
  | { kind: "unverified"; reason: McpCanaryUnverifiedReason };

/**
 * Hardcoded, code-only: adding support for a new MCP server means adding an
 * entry here plus an example config to the registry self-check test.
 */
export const mcpCanaryRegistry: readonly McpCanaryRegistryEntry[] = [
  {
    // Matched on args because the server name is author-chosen and often
    // something generic like `browser`.
    id: "playwright",
    matcher: { field: "args", pattern: /playwright\/mcp/ },
    canary: { tool: "browser_navigate", args: { url: "about:blank" } },
  },
  {
    // Matched on args because the server name is author-chosen (`postgres`,
    // `db`, ...) while the command always names the `postgres-mcp` package,
    // however it is launched (uvx, pipx, docker, bespoke wrappers).
    id: "postgres",
    matcher: { field: "args", pattern: /postgres-mcp/ },
    canary: { tool: "list_schemas", args: {} },
  },
];

/**
 * Matchers are always case-insensitive, whether or not the entry author wrote
 * the `i` flag. Rebuilding the regex per call also keeps a `g`- or `y`-flagged
 * pattern from carrying `lastIndex` state from one server to the next.
 */
function matchesPattern(pattern: RegExp, value: string): boolean {
  const flags = pattern.flags.includes("i")
    ? pattern.flags
    : `${pattern.flags}i`;

  return new RegExp(pattern.source, flags).test(value);
}

function matcherTarget(
  matcher: McpCanaryMatcher,
  serverName: string,
  command: string[],
): string {
  return matcher.field === "name" ? serverName : command.join(" ");
}

/**
 * Every registry entry whose matcher claims this server, in registry order.
 * Exposed so the registry self-check test can detect ambiguity directly;
 * production callers want {@link matchMcpCanary}.
 *
 * Non-`local` servers (remote, or a bare `{ enabled }` override) never match.
 */
export function findMcpCanaryEntries(
  serverName: string,
  config: OpenCodeMcpServerConfig,
  registry: readonly McpCanaryRegistryEntry[] = mcpCanaryRegistry,
): McpCanaryRegistryEntry[] {
  if (!("type" in config) || config.type !== "local") {
    return [];
  }

  const { command } = config;

  return registry.filter((entry) =>
    matchesPattern(
      entry.matcher.pattern,
      matcherTarget(entry.matcher, serverName, command),
    ),
  );
}

export type MatchMcpCanaryOptions = {
  registry?: readonly McpCanaryRegistryEntry[];
  /** Injectable for tests; defaults to the worker's error log. */
  logError?: (message: string, details: Record<string, unknown>) => void;
};

/**
 * Resolve the canary call for a single configured MCP server.
 *
 * - No match (including any non-`local` server) → `unverified`. Not a failure:
 *   most MCP servers simply have no canary registered yet.
 * - Exactly one match → that entry's canary, with the tool name qualified as
 *   `${serverName}_${toolName}` per OpenCode's MCP tool naming.
 * - More than one match → `unverified` plus an error-level log. The registry is
 *   wrong, but that is our bug to fix, not a reason to fail the caller.
 */
export function matchMcpCanary(
  serverName: string,
  config: OpenCodeMcpServerConfig,
  options?: MatchMcpCanaryOptions,
): McpCanaryMatch {
  const matched = findMcpCanaryEntries(serverName, config, options?.registry);
  const [entry] = matched;

  if (entry === undefined) {
    return { kind: "unverified", reason: "no-match" };
  }

  if (matched.length > 1) {
    const logError =
      options?.logError ??
      ((message, details) => {
        logWorkError("mcp-canary", message, details);
      });

    logError(
      `MCP canary registry matched ${String(matched.length)} entries for server "${serverName}"; ` +
        `skipping its canary. This is a bug in Boboddy — please file an issue at ${MCP_CANARY_ISSUE_URL}.`,
      { serverName, matchedEntryIds: matched.map((entry) => entry.id) },
    );

    return { kind: "unverified", reason: "ambiguous-match" };
  }

  return {
    kind: "matched",
    entryId: entry.id,
    canary: {
      tool: `${serverName}_${entry.canary.tool}`,
      // Copied so a caller can't mutate the hardcoded registry in place.
      args: { ...entry.canary.args },
    },
  };
}
