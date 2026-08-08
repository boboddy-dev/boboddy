/**
 * The health check runner (#119): given a launched environment and a step's
 * declared health checks (`defineStep`'s `healthChecks` field), produces an
 * outcome for each one.
 *
 * Replaced the dry-run canary orchestration's registry-lookup model
 * (the now-deleted `mcpCanaryRegistry`/`matchMcpCanary`, #121) with declared
 * checks: there is no matching, no ambiguity, and no hardcoded server list
 * here. The forced-call invoker underneath
 * (`forceAndVerifyMcpHealthCheck`) needed no generalisation — it already
 * accepts a caller-supplied `{ tool, args }`.
 *
 * Per the #114 spike: MCP tools never appear in OpenCode's
 * `/experimental/tool/ids` / `/experimental/tool` enumeration, regardless of
 * how the server is declared, while plugin-provided and standalone
 * (`.opencode/tools/`) tools do. So id-resolution fast-failing and pre-call
 * Ajv argument validation only apply to checks with no `mcp` qualifier — an
 * `mcp`-qualified check skips both and goes straight to the forced call,
 * letting a genuinely missing or broken MCP tool fail there instead (exactly
 * `forceAndVerifyMcpHealthCheck`'s existing `tool-error` path). Treating an
 * MCP tool's absence from the enumeration as `not-registered` would produce a
 * false positive against every correctly configured MCP health check.
 */
import Ajv from "ajv/dist/2020";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type {
  HealthCheck,
  HealthCheckSeverity,
} from "@boboddy/sdk/health-checks";
import type { FakeAiServer } from "../infra/fake-ai/fake-ai-server";
import {
  FAKE_MODEL_ID,
  FAKE_PROVIDER_ID,
} from "../infra/fake-ai/fake-provider-config";
import { forceAndVerifyMcpHealthCheck } from "./force-and-verify-mcp-health-check";
import { logWorkError } from "./work-logger";

/**
 * Resolve a declared health check to the flat tool id OpenCode calls it by:
 * `${mcp}_${tool}` when `mcp` is set, matching OpenCode's MCP tool-naming
 * convention, or `tool` verbatim otherwise — plugin tools, standalone tools,
 * and built-ins already share one flat namespace, so no qualifier applies.
 */
export function resolveHealthCheckToolId(check: HealthCheck): string {
  return check.mcp ? `${check.mcp}_${check.tool}` : check.tool;
}

export type HealthCheckOutcome =
  | { kind: "passed" }
  | {
      kind: "failed";
      reason:
        | "not-registered"
        | "invalid-args"
        | "tool-error"
        | "timeout"
        | "session-error";
      detail: string;
      /** Only set for `not-registered`: every id OpenCode does know about. */
      availableIds?: string[];
    }
  /**
   * Not reached because an earlier `required` check aborted the run. Distinct
   * from a failure — this check was never attempted at all.
   */
  | { kind: "skipped" };

export type HealthCheckReport = {
  /** `check.name`, defaulting to the resolved tool id. */
  name: string;
  resolvedId: string;
  severity: HealthCheckSeverity;
  outcome: HealthCheckOutcome;
};

export type RunHealthChecksInput = {
  agentBaseUrl: string;
  workspaceFolder: string;
  /**
   * In declaration order. `required` checks run before `warn` ones
   * regardless of how the two severities are interleaved in this array — see
   * {@link runHealthChecks}.
   */
  healthChecks: HealthCheck[];
  /** Already started; shared across every check this call runs. */
  fakeAiServer: FakeAiServer;
};

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createClient(agentBaseUrl: string, workspaceFolder: string) {
  return createOpencodeClient({
    baseUrl: agentBaseUrl,
    directory: workspaceFolder,
  });
}

/**
 * Lazily fetches and caches OpenCode's two tool-enumeration endpoints.
 * `mcp`-qualified checks never trigger either fetch (see file comment), so a
 * step whose declared checks are all MCP calls never queries them at all.
 */
class ToolEnumeration {
  private idsPromise: Promise<Set<string>> | undefined;
  private schemasPromise: Promise<Map<string, unknown>> | undefined;

  constructor(
    private readonly client: ReturnType<typeof createClient>,
    private readonly agentBaseUrl: string,
    private readonly workspaceFolder: string,
  ) {}

  async ids(): Promise<Set<string>> {
    this.idsPromise ??= this.fetchIds();
    return this.idsPromise;
  }

  async schemaFor(toolId: string): Promise<unknown> {
    this.schemasPromise ??= this.fetchSchemas();
    return (await this.schemasPromise).get(toolId);
  }

  private async fetchIds(): Promise<Set<string>> {
    try {
      const response = await this.client.tool.ids({
        query: { directory: this.workspaceFolder },
      });
      return new Set(response.data ?? []);
    } catch (error) {
      logWorkError("health-check", "Failed to enumerate registered tool ids", {
        agentBaseUrl: this.agentBaseUrl,
        error: errorMessage(error),
      });
      return new Set();
    }
  }

  private async fetchSchemas(): Promise<Map<string, unknown>> {
    try {
      // `provider`/`model` are required query params, not used to select a
      // provider-specific schema dialect here — the synthetic health-checker
      // provider/model are always registered whenever this runner is
      // invoked (its caller is the reason the launch baked them in).
      const response = await this.client.tool.list({
        query: {
          directory: this.workspaceFolder,
          provider: FAKE_PROVIDER_ID,
          model: FAKE_MODEL_ID,
        },
      });
      return new Map(
        (response.data ?? []).map((tool) => [tool.id, tool.parameters]),
      );
    } catch (error) {
      logWorkError("health-check", "Failed to fetch tool schemas", {
        agentBaseUrl: this.agentBaseUrl,
        error: errorMessage(error),
      });
      return new Map();
    }
  }
}

type ArgsValidation =
  | { kind: "valid" }
  | { kind: "invalid"; detail: string }
  /** The schema itself failed to compile; validation is skipped, not failed. */
  | { kind: "unavailable" };

/**
 * Validates `args` against `schema` with Ajv, formatting errors as instance
 * path plus message — the same idiom `boboddy-submit-step-findings` (plugin)
 * and `process-project-work-findings.ts` (worker) already use for authoring
 * errors.
 *
 * A schema that fails to *compile* — e.g. the recursive `$ref`-vs-`$defs`
 * mismatch the #114 spike found on at least one real plugin tool's generated
 * schema — is reported as `"unavailable"`, not `"invalid"`: the schema itself
 * is broken, not the caller's arguments, so this is not an authoring error.
 */
function validateArgs(
  schema: object,
  args: Record<string, unknown>,
): ArgsValidation {
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch {
    return { kind: "unavailable" };
  }

  if (validate(args)) {
    return { kind: "valid" };
  }

  const details = (validate.errors ?? [])
    .map(
      (issue) => `${issue.instancePath || "/"} ${issue.message ?? "invalid"}`,
    )
    .join("; ");
  return { kind: "invalid", detail: details || "validation failed" };
}

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a dynamically fetched value, not a real input boundary
function isSchemaObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

async function runOneCheck(input: {
  check: HealthCheck;
  resolvedId: string;
  enumeration: ToolEnumeration;
  agentBaseUrl: string;
  workspaceFolder: string;
  fakeAiServer: FakeAiServer;
}): Promise<HealthCheckOutcome> {
  const {
    check,
    resolvedId,
    enumeration,
    agentBaseUrl,
    workspaceFolder,
    fakeAiServer,
  } = input;
  const args = check.args ?? {};

  if (!check.mcp) {
    const registeredIds = await enumeration.ids();
    if (!registeredIds.has(resolvedId)) {
      return {
        kind: "failed",
        reason: "not-registered",
        detail: `Tool "${resolvedId}" is not registered in this environment.`,
        availableIds: [...registeredIds].sort(),
      };
    }

    const schema = await enumeration.schemaFor(resolvedId);
    if (isSchemaObject(schema)) {
      const validation = validateArgs(schema, args);
      if (validation.kind === "invalid") {
        return {
          kind: "failed",
          reason: "invalid-args",
          detail: validation.detail,
        };
      }
    }
  }

  const verification = await forceAndVerifyMcpHealthCheck({
    agentBaseUrl,
    workspaceFolder,
    healthCheck: { tool: resolvedId, args },
    fakeAiServer,
    timeoutMs: check.timeoutMs,
  });

  return verification.passed
    ? { kind: "passed" }
    : {
        kind: "failed",
        reason: verification.reason,
        detail: verification.detail,
      };
}

/** Narrows {@link HealthCheckOutcome} to just the `failed` variant. */
export type FailedHealthCheckOutcome = Extract<
  HealthCheckOutcome,
  { kind: "failed" }
>;

/**
 * Finds the first `required` check whose outcome is `failed`, in report
 * order (which matches declaration order — see {@link runHealthChecks}).
 * Used by real step execution (#120) to decide whether to kill the step
 * before the agent is prompted; `warn` failures are advisory and never
 * matched here.
 */
export function findFailedRequiredHealthCheck(
  reports: HealthCheckReport[],
): { report: HealthCheckReport; outcome: FailedHealthCheckOutcome } | undefined {
  for (const report of reports) {
    if (report.severity === "required" && report.outcome.kind === "failed") {
      return { report, outcome: report.outcome };
    }
  }
  return undefined;
}

/**
 * Renders a failed health check as a human-readable message for the step
 * failure it produces — the only diagnostic a user gets if they don't dig
 * into the log feed for the forced call's tool output.
 */
export function describeFailedHealthCheck(
  report: HealthCheckReport,
  outcome: FailedHealthCheckOutcome,
): string {
  const availableIdsSuffix =
    outcome.availableIds && outcome.availableIds.length > 0
      ? ` Available tool ids: ${outcome.availableIds.join(", ")}.`
      : "";
  return `Health check "${report.name}" (${report.resolvedId}) failed [${outcome.reason}]: ${outcome.detail}${availableIdsSuffix}`;
}

function buildReport(
  check: HealthCheck,
  resolvedId: string,
  outcome: HealthCheckOutcome,
): HealthCheckReport {
  return {
    name: check.name ?? resolvedId,
    resolvedId,
    severity: check.severity,
    outcome,
  };
}

/**
 * Runs a step's declared health checks against a launched environment and
 * reports an outcome for each one, returned in the same order as
 * `input.healthChecks`.
 *
 * `required` checks run first, in declaration order; the first failure
 * aborts everything after it — every remaining `required` check AND every
 * `warn` check report `skipped`, since they were never attempted. If every
 * `required` check passes, `warn` checks then run, also in declaration
 * order; a `warn` failure never aborts anything else, since `warn` exists
 * precisely to be advisory (see `healthCheckSeverityValues`).
 */
export async function runHealthChecks(
  input: RunHealthChecksInput,
): Promise<HealthCheckReport[]> {
  const { agentBaseUrl, workspaceFolder, healthChecks, fakeAiServer } = input;

  if (healthChecks.length === 0) {
    return [];
  }

  const client = createClient(agentBaseUrl, workspaceFolder);
  const enumeration = new ToolEnumeration(
    client,
    agentBaseUrl,
    workspaceFolder,
  );

  const indexed = healthChecks.map((check, index) => ({ check, index }));
  const required = indexed.filter(({ check }) => check.severity === "required");
  const warn = indexed.filter(({ check }) => check.severity === "warn");

  const reportByIndex = new Map<number, HealthCheckReport>();
  let aborted = false;

  for (const { check, index } of required) {
    const resolvedId = resolveHealthCheckToolId(check);
    if (aborted) {
      reportByIndex.set(
        index,
        buildReport(check, resolvedId, { kind: "skipped" }),
      );
      continue;
    }
    const outcome = await runOneCheck({
      check,
      resolvedId,
      enumeration,
      agentBaseUrl,
      workspaceFolder,
      fakeAiServer,
    });
    reportByIndex.set(index, buildReport(check, resolvedId, outcome));
    if (outcome.kind === "failed") {
      aborted = true;
    }
  }

  for (const { check, index } of warn) {
    const resolvedId = resolveHealthCheckToolId(check);
    if (aborted) {
      reportByIndex.set(
        index,
        buildReport(check, resolvedId, { kind: "skipped" }),
      );
      continue;
    }
    const outcome = await runOneCheck({
      check,
      resolvedId,
      enumeration,
      agentBaseUrl,
      workspaceFolder,
      fakeAiServer,
    });
    reportByIndex.set(index, buildReport(check, resolvedId, outcome));
  }

  return healthChecks.map((_, index) => {
    const report = reportByIndex.get(index);
    if (!report) {
      throw new Error(
        `Internal error: the health check runner produced no report for index ${String(index)}`,
      );
    }
    return report;
  });
}
