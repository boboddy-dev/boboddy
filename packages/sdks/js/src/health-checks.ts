import { z } from "zod";

/**
 * Severity of a step-declared health check.
 *
 * `required` (default) fails the step immediately if the check fails.
 * `warn` is advisory — it is reported but never fails the step.
 */
export const healthCheckSeverityValues = ["required", "warn"] as const;
export type HealthCheckSeverity = (typeof healthCheckSeverityValues)[number];

/**
 * Fields shared by every health-check `kind`: the scheduling/reporting
 * envelope read by `runPhase`/`runLane` (`packages/worker`), which never
 * looks past `severity`/`serialGroup` regardless of what a check actually
 * verifies.
 *
 * By default, checks run in parallel with each other (grouped only by
 * `severity` — see `healthCheckSeverityValues`). Set `serialGroup` to a
 * shared string on any checks that contend over the same underlying resource
 * (e.g. two checks against the same database, or two checks that can't share
 * a browser instance) — checks with the same `serialGroup` value run one at
 * a time, in declaration order, while still running concurrently with every
 * other check/group. See `runHealthChecks` (`packages/worker`) for the
 * execution model this backs.
 */
const healthCheckBaseSchema = z.object({
  name: z.string().trim().min(1).optional(),
  severity: z.enum(healthCheckSeverityValues).default("required"),
  timeoutMs: z.int().gt(0).max(Number.MAX_SAFE_INTEGER).default(15000),
  serialGroup: z.string().trim().min(1).optional(),
});

/**
 * A health check verified by forcing a real OpenCode tool call against the
 * launched environment before the agent starts working.
 *
 * `tool` is a bare tool name when `mcp` is set (resolved at runtime to
 * `${mcp}_${tool}`, matching OpenCode's MCP tool-naming convention), or a flat
 * tool id otherwise (plugin tools, standalone tools, built-ins already share
 * one flat namespace, so no qualifier applies).
 */
export const toolHealthCheckSchema = healthCheckBaseSchema
  .extend({
    kind: z.literal("tool").default("tool"),
    tool: z.string().trim().min(1),
    mcp: z.string().trim().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * A health check verified by running a command through OpenCode's `bash`
 * tool inside the step's actual execution environment, and reading the real
 * exit code back out of the tool result (not just call-completion status —
 * see `force-and-verify-cli-health-check.ts`).
 */
export const cliHealthCheckSchema = healthCheckBaseSchema
  .extend({
    kind: z.literal("cli"),
    command: z.array(z.string().min(1)).min(1),
    expectExitCode: z.int().default(0),
  })
  .strict();

/**
 * Every already-persisted `healthChecksJson` (DB rows, pushed step files) was
 * written before `kind` existed. `z.discriminatedUnion` reads the raw input
 * to pick a branch before any per-branch `.default()` applies, so a legacy
 * check with no `kind` field at all would otherwise fail to match either arm
 * — this preprocess step defaults it to `"tool"` first so those checks keep
 * parsing unchanged.
 */
// eslint-disable-next-line local/no-unknown-parameter-type -- z.preprocess's callback is the raw-input boundary itself, before any schema has validated the shape
function injectDefaultKind(value: unknown): unknown {
  if (typeof value === "object" && value !== null && !("kind" in value)) {
    return { ...value, kind: "tool" };
  }
  return value;
}

export const healthCheckSchema = z.preprocess(
  injectDefaultKind,
  z.discriminatedUnion("kind", [toolHealthCheckSchema, cliHealthCheckSchema]),
);

/**
 * The full value of a step's `healthChecks` field.
 */
export const healthChecksSchema = z.array(healthCheckSchema);

export type ToolHealthCheck = z.infer<typeof toolHealthCheckSchema>;
export type CliHealthCheck = z.infer<typeof cliHealthCheckSchema>;
export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type HealthChecks = z.infer<typeof healthChecksSchema>;

/**
 * The pre-parse authoring shape of a single health check — what a step
 * author actually writes in `defineStep({ healthChecks: [...] })` — as
 * opposed to `HealthCheck`, the post-parse output shape `packages/worker`'s
 * runner narrows on (`kind` always present, defaulted).
 *
 * Derived from the two arm schemas directly (`z.input<typeof
 * toolHealthCheckSchema | typeof cliHealthCheckSchema>`), not from
 * `healthCheckSchema`/`healthChecksSchema` — those are `z.preprocess`-wrapped,
 * and a preprocessed schema's `z.input` type collapses to `unknown` (the
 * preprocess function's own input is unconstrained), so it can't back a
 * real authoring-time type. `kind` is optional on the tool arm (it
 * defaults to `"tool"` — decision ledger #2's "omit `kind` for a tool
 * check" ergonomics apply at the authoring layer too, not just to legacy
 * persisted rows) and a required literal `"cli"` on the cli arm (no
 * default exists for it).
 */
export type HealthCheckInput =
  | z.input<typeof toolHealthCheckSchema>
  | z.input<typeof cliHealthCheckSchema>;

/** The pre-parse authoring shape of a step's `healthChecks` field. */
export type HealthChecksInput = HealthCheckInput[];
