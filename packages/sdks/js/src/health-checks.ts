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
 * A single step-declared health check: a real tool call made against the
 * launched environment before the agent starts working.
 *
 * `tool` is a bare tool name when `mcp` is set (resolved at runtime to
 * `${mcp}_${tool}`, matching OpenCode's MCP tool-naming convention), or a flat
 * tool id otherwise (plugin tools, standalone tools, built-ins already share
 * one flat namespace, so no qualifier applies).
 */
export const healthCheckSchema = z
  .object({
    tool: z.string().trim().min(1),
    mcp: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    severity: z.enum(healthCheckSeverityValues).default("required"),
    timeoutMs: z.int().gt(0).max(Number.MAX_SAFE_INTEGER).default(15000),
  })
  .strict();

/**
 * The full value of a step's `healthChecks` field.
 */
export const healthChecksSchema = z.array(healthCheckSchema);

export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type HealthChecks = z.infer<typeof healthChecksSchema>;
