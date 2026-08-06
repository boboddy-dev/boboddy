/**
 * Wires the MCP canary registry/matcher (#108) and the forced-tool-call
 * verifier (#109) into the dry-run's per-server report: for every `connected`,
 * `local` MCP server the handshake check already found, resolve whether the
 * registry knows a canary for it and, if so, actually run it.
 *
 * Reuses a single, already-started {@link FakeAiServer} instance across every
 * canaried server in one dry run — this function only calls `.configure()` on
 * it, once per matched server, immediately before forcing that server's
 * canary call. Starting/stopping the shared instance is the caller's
 * responsibility (`run-work-dry-run.ts`), same division of ownership
 * `forceAndVerifyMcpCanary` (#109) already established.
 */
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpenCodeMcpServerConfig } from "../../../common/contracts/opencode-mcp";
import type { FakeAiServer } from "../infra/fake-ai/fake-ai-server";
import {
  matchMcpCanary,
  type McpCanaryRegistryEntry,
  type McpCanaryUnverifiedReason,
} from "./mcp-canary-registry";
import { forceAndVerifyMcpCanary } from "./force-and-verify-mcp-canary";
import type { McpHandshakeReport } from "./run-work-dry-run-health-checks";
import { logWork, logWorkError } from "./work-logger";

/**
 * Beyond the two reasons `matchMcpCanary` (#108) itself reports:
 * - `not-connected` — the handshake never reached `connected` (already
 *   unhealthy, or intentionally `disabled`); canarying it would prove nothing.
 * - `not-local` — the server isn't `local` in the agent's resolved config
 *   (remote, a bare `{enabled}` override, or the config wasn't found at all),
 *   which `matchMcpCanary` never canaries.
 * - `harness-unavailable` — an earlier canary's OpenCode session failed at the
 *   harness/provider level (`session-error`), so this canary was never
 *   launched. A harness failure is global, not per-server: running the rest
 *   would only reprint the same cause N times and burn the 30s timeout each
 *   time. Unlike every other reason here, this one means verification was
 *   *owed* and could not be done — see {@link computeDryRunOk}.
 */
export type McpCanaryUnverifiedReasonExtended =
  | McpCanaryUnverifiedReason
  | "not-connected"
  | "not-local"
  | "harness-unavailable";

export type McpCanaryOutcome =
  | { kind: "ran-and-passed" }
  | {
      kind: "ran-and-failed";
      reason: "tool-error" | "timeout" | "session-error";
      detail: string;
    }
  | { kind: "unverified"; reason: McpCanaryUnverifiedReasonExtended };

/** The dry-run report's per-server shape: handshake status plus canary outcome. */
export type WorkDryRunMcpServerReport = McpHandshakeReport & {
  canary: McpCanaryOutcome;
};

export type RunMcpCanariesInput = {
  agentBaseUrl: string;
  workspaceFolder: string;
  mcpServers: McpHandshakeReport[];
  /** Already started; this function only calls `.configure()` on it. */
  fakeAiServer: FakeAiServer;
  /** Injectable for tests; defaults to the production `mcpCanaryRegistry`. */
  registry?: readonly McpCanaryRegistryEntry[] | undefined;
};

async function fetchResolvedMcpConfig(
  agentBaseUrl: string,
  workspaceFolder: string,
): Promise<Record<string, OpenCodeMcpServerConfig>> {
  const client = createOpencodeClient({
    baseUrl: agentBaseUrl,
    directory: workspaceFolder,
  });
  try {
    const response = await client.config.get({
      query: { directory: workspaceFolder },
    });
    return response.data?.mcp ?? {};
  } catch (error) {
    logWorkError(
      "dry-run",
      "Failed to read the resolved MCP config for canary matching",
      {
        agentBaseUrl,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return {};
  }
}

async function resolveCanaryOutcome(input: {
  server: McpHandshakeReport;
  config: OpenCodeMcpServerConfig | undefined;
  agentBaseUrl: string;
  workspaceFolder: string;
  fakeAiServer: FakeAiServer;
  registry: readonly McpCanaryRegistryEntry[] | undefined;
}): Promise<WorkDryRunMcpServerReport> {
  const { server, config, agentBaseUrl, workspaceFolder, fakeAiServer, registry } =
    input;

  if (server.status !== "connected") {
    return { ...server, canary: { kind: "unverified", reason: "not-connected" } };
  }
  if (config === undefined || !("type" in config) || config.type !== "local") {
    return { ...server, canary: { kind: "unverified", reason: "not-local" } };
  }

  const match = matchMcpCanary(server.name, config, { registry });
  if (match.kind === "unverified") {
    return { ...server, canary: { kind: "unverified", reason: match.reason } };
  }

  const verification = await forceAndVerifyMcpCanary({
    agentBaseUrl,
    workspaceFolder,
    canary: match.canary,
    fakeAiServer,
  });

  return {
    ...server,
    canary: verification.passed
      ? { kind: "ran-and-passed" }
      : {
          kind: "ran-and-failed",
          reason: verification.reason,
          detail: verification.detail,
        },
  };
}

/**
 * Whether a single canary outcome is compatible with a green dry run.
 *
 * The `"unverified"` reasons split in two:
 * - `no-match`, `ambiguous-match`, `not-connected`, `not-local` — there was
 *   nothing to verify (or nothing we know how to verify). Benign; the dry run
 *   stays green, exactly as before.
 * - `harness-unavailable` — there *was* something to verify and the AI harness
 *   died before we could. Reporting "ok" there would claim an environment is
 *   good when we never tested it, so it counts against the run. In practice
 *   the same report always carries the originating `session-error` canary
 *   (which already fails), but this is stated explicitly rather than relying
 *   on that pairing.
 */
function canaryAllowsOk(canary: McpCanaryOutcome): boolean {
  switch (canary.kind) {
    case "ran-and-passed":
      return true;
    case "ran-and-failed":
      return false;
    case "unverified":
      return canary.reason !== "harness-unavailable";
  }
}

/**
 * True only when container + OpenCode health are both fine, every MCP server
 * passed its handshake, and every canary either passed or was benignly
 * unverified. A canary that ran and failed sits at the same severity tier as a
 * failed handshake; so does a canary we were unable to judge because the AI
 * harness itself failed (see {@link canaryAllowsOk}).
 */
export function computeDryRunOk(input: {
  containerHealthy: boolean | undefined;
  opencodeHealthy: boolean;
  mcpServers: WorkDryRunMcpServerReport[];
}): boolean {
  return (
    (input.containerHealthy ?? true) &&
    input.opencodeHealthy &&
    input.mcpServers.every((server) => server.healthy) &&
    input.mcpServers.every((server) => canaryAllowsOk(server.canary))
  );
}

function isSessionErrorOutcome(canary: McpCanaryOutcome): boolean {
  return canary.kind === "ran-and-failed" && canary.reason === "session-error";
}

/**
 * Resolves every server's canary outcome, sequentially — the shared
 * `fakeAiServer` is mutable, single-purpose state (`.configure()` sets what
 * the *next* forced call scripts), so two canaries can never run concurrently
 * against it.
 *
 * Short-circuits on the first `session-error`: that is the AI harness failing,
 * which is global rather than per-server, so every canary after it is reported
 * `unverified: harness-unavailable` without being launched. The canary that
 * actually errored keeps its `session-error` outcome — it carries the real
 * cause — and canaries that already produced a verdict keep theirs.
 */
export async function runMcpCanaries(
  input: RunMcpCanariesInput,
): Promise<WorkDryRunMcpServerReport[]> {
  const { agentBaseUrl, workspaceFolder, mcpServers, fakeAiServer, registry } = input;

  if (mcpServers.length === 0) {
    return [];
  }

  const resolvedMcpConfig = await fetchResolvedMcpConfig(
    agentBaseUrl,
    workspaceFolder,
  );

  const results: WorkDryRunMcpServerReport[] = [];
  let harnessUnavailable = false;

  for (const server of mcpServers) {
    if (harnessUnavailable) {
      results.push({
        ...server,
        canary: { kind: "unverified", reason: "harness-unavailable" },
      });
      continue;
    }

    const result = await resolveCanaryOutcome({
      server,
      config: resolvedMcpConfig[server.name],
      agentBaseUrl,
      workspaceFolder,
      fakeAiServer,
      registry,
    });
    results.push(result);

    if (isSessionErrorOutcome(result.canary)) {
      harnessUnavailable = true;
      logWork(
        "dry-run",
        "The AI harness failed a canary session; skipping the remaining MCP canaries",
        { failedOnServer: server.name },
      );
    }
  }
  return results;
}
