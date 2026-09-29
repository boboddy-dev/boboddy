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
import { forceAndVerifyCliHealthCheck } from "./force-and-verify-cli-health-check";
import { forceAndVerifyMcpHealthCheck } from "./force-and-verify-mcp-health-check";
import { pollMcpStatus } from "./poll-mcp-status";
import { logWork, logWorkError } from "./work-logger";

/**
 * Resolve a declared health check to the id shown in reports: `${mcp}_${tool}`
 * when a `"tool"` check's `mcp` is set, matching OpenCode's MCP tool-naming
 * convention; `tool` verbatim otherwise — plugin tools, standalone tools, and
 * built-ins already share one flat namespace, so no qualifier applies. A
 * `"cli"` check has no OpenCode-side tool id to resolve to (it always runs
 * through the fixed `bash` built-in — see `force-and-verify-cli-health-check.ts`),
 * so its declared `command`, joined with spaces, stands in for reporting
 * purposes instead.
 */
export function resolveHealthCheckToolId(check: HealthCheck): string {
  if (check.kind === "cli") {
    return check.command.join(" ");
  }
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
        | "session-error"
        | "nonzero-exit";
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
  /** The declared check's `kind` — carried through so reporting (`apps/cli`'s dry-run output) can render `"tool"` and `"cli"` checks differently. */
  kind: HealthCheck["kind"];
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

/**
 * `"tool"`-kind checks fast-fail against OpenCode's tool enumeration and
 * validate `args` against the tool's own schema before ever forcing a call —
 * see the file comment for why an `mcp`-qualified check skips both. `"cli"`
 * checks have nothing to enumerate or validate against: the `bash` tool is a
 * fixed OpenCode built-in (decision ledger #3 in the plan — no new
 * exec-in-container primitive), so there is no id to resolve and no
 * per-command argument schema to check `command`/`expectExitCode` against.
 * They go straight to `forceAndVerifyCliHealthCheck`.
 */
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

  switch (check.kind) {
    case "cli": {
      const verification = await forceAndVerifyCliHealthCheck({
        agentBaseUrl,
        workspaceFolder,
        command: check.command,
        expectExitCode: check.expectExitCode,
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
    case "tool": {
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
  }
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
    kind: check.kind,
    outcome,
  };
}

type IndexedCheck = { check: HealthCheck; index: number };

/**
 * Shared across every lane in a single phase (see {@link runPhase}): once any
 * lane's check fails as `required`, every OTHER lane checks this before
 * starting its own next check. This is a best-effort abort, not a hard stop —
 * a check already in flight when the flag flips is not cancelled and its real
 * outcome (pass or fail) is kept; only checks that haven't started yet get
 * `skipped`. Trading determinism for speed here is deliberate: with several
 * lanes genuinely running in parallel, there is no single well-defined
 * "everything after the failure" to abort atomically the way the old fully
 * sequential runner could.
 */
type AbortFlag = { aborted: boolean };

/**
 * Runs one lane — checks that share a `serialGroup` (or a single ungrouped
 * check) — strictly one at a time, in declaration order, honouring `abort`
 * before starting each one. Lanes themselves run concurrently with each
 * other; see {@link runPhase}.
 */
async function runLane(
  lane: IndexedCheck[],
  context: {
    enumeration: ToolEnumeration;
    agentBaseUrl: string;
    workspaceFolder: string;
    fakeAiServer: FakeAiServer;
  },
  abort: AbortFlag,
  reportByIndex: Map<number, HealthCheckReport>,
): Promise<void> {
  for (const { check, index } of lane) {
    const resolvedId = resolveHealthCheckToolId(check);
    if (abort.aborted) {
      reportByIndex.set(
        index,
        buildReport(check, resolvedId, { kind: "skipped" }),
      );
      continue;
    }
    const outcome = await runOneCheck({
      check,
      resolvedId,
      ...context,
    });
    reportByIndex.set(index, buildReport(check, resolvedId, outcome));
    if (outcome.kind === "failed" && check.severity === "required") {
      abort.aborted = true;
    }
  }
}

/**
 * Groups `entries` into lanes — checks sharing a `serialGroup` value become
 * one lane (run sequentially, in declaration order, relative to each other);
 * every ungrouped check gets its own single-check lane — then runs every
 * lane concurrently. Used once per severity phase (see {@link
 * runHealthChecks}), never across phases: `required` and `warn` are already
 * separated by a full `await` barrier, so a `serialGroup` shared between a
 * `required` and a `warn` check is naturally never a concurrency concern.
 */
async function runPhase(
  entries: IndexedCheck[],
  context: {
    enumeration: ToolEnumeration;
    agentBaseUrl: string;
    workspaceFolder: string;
    fakeAiServer: FakeAiServer;
  },
  abort: AbortFlag,
  reportByIndex: Map<number, HealthCheckReport>,
): Promise<void> {
  const groups = new Map<string, IndexedCheck[]>();
  const lanes: IndexedCheck[][] = [];

  for (const entry of entries) {
    const key = entry.check.serialGroup;
    if (key === undefined) {
      lanes.push([entry]);
      continue;
    }
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      const newGroup = [entry];
      groups.set(key, newGroup);
      lanes.push(newGroup);
    }
  }

  await Promise.all(
    lanes.map((lane) => runLane(lane, context, abort, reportByIndex)),
  );
}

/**
 * Runs a step's declared health checks against a launched environment and
 * reports an outcome for each one, returned in the same order as
 * `input.healthChecks`.
 *
 * Two phases run in strict order: every `required` check, then every `warn`
 * check — a `warn` failure never aborts anything, since `warn` exists
 * precisely to be advisory (see `healthCheckSeverityValues`).
 *
 * Within a phase, checks run in PARALLEL by default: each check is its own
 * lane. Set `serialGroup` on checks that contend over the same underlying
 * resource (a shared database, a browser that can't run two sessions at
 * once, etc.) — checks sharing a `serialGroup` value form one lane and run
 * one at a time, in declaration order, while still running concurrently with
 * every other lane. See {@link runPhase}/{@link runLane}.
 *
 * A `required` failure sets a shared abort flag every lane checks before
 * starting its next check; this is best-effort, not a hard stop — see {@link
 * AbortFlag}. If the `required` phase ends with the flag set, the entire
 * `warn` phase is skipped without attempting a single check (that part IS
 * deterministic: phases are separated by a full `await`, so nothing in the
 * `warn` phase has started yet when this decision is made).
 */
export async function runHealthChecks(
  input: RunHealthChecksInput,
): Promise<HealthCheckReport[]> {
  const { agentBaseUrl, workspaceFolder, healthChecks, fakeAiServer } = input;

  if (healthChecks.length === 0) {
    return [];
  }

  // Warm-up: give slow-starting MCP servers (e.g. an `npx`-installed one, or
  // a cold-starting browser like Playwright/Chromium) a chance to finish
  // connecting before the first declared check forces a tool call. Without
  // this, a real (non-dry-run) run could spuriously time out a health check
  // against a server that just hadn't finished starting yet — the dry-run
  // path already does this same poll before its checks run (in
  // `run-work-dry-run.ts`), so this brings real execution to parity with it.
  // Runs regardless of whether any declared check is `mcp`-qualified,
  // matching the dry-run's existing unconditional behavior. Purely a warm-up
  // side effect for v1 — its report isn't used to gate anything here.
  const report = await pollMcpStatus(agentBaseUrl, workspaceFolder);
  logWork("health-check", "MCP servers ready before health checks", {
    report,
  });

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
  const abort: AbortFlag = { aborted: false };
  const context = { enumeration, agentBaseUrl, workspaceFolder, fakeAiServer };

  await runPhase(required, context, abort, reportByIndex);
  await runPhase(warn, context, abort, reportByIndex);

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
