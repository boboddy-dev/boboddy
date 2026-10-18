import { envVarsSchema, type EnvVarApplies } from "../../env-vars";
import type { StepDefinitionSpec } from "../steps/define-step";
import { listPaths, type DefinitionValidationIssue } from "./validation-issue";

/**
 * Checks a step's declared env vars:
 *
 * - they satisfy the `envVarsSchema` wire schema (names, reserved names,
 *   secret rules, size caps). The authoring helpers (`Env`, `normalizeEnv`)
 *   already guard the common mistakes at definition time; this catches
 *   hand-built or generated specs that bypass them.
 * - an inherit entry's `mcp` names a server in the step's `opencodeMcpJson`.
 * - `applies: "setup"` or `"both"` only on a `workspace` step (a host step has
 *   no container to set up) and never on an MCP variable (MCP servers run
 *   inside the agent).
 */
export function checkEnv(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    if (!step.envJson) continue;
    issues.push(...checkEnvMcpOwners(step));
    issues.push(...checkEnvApplies(step));
    const result = envVarsSchema.safeParse(step.envJson);
    if (result.success) continue;

    for (const issue of result.error.issues) {
      const [index, ...field] = issue.path;
      const entry = typeof index === "number" ? step.envJson[index] : undefined;
      const where =
        typeof index === "number" && entry
          ? `Step "${step.key}" env var #${String(index + 1)} ("${entry.name}")`
          : `Step "${step.key}" env`;
      const fieldLabel =
        field.length > 0 ? ` ${field.map(String).join(".")}` : "";
      issues.push({
        check: "env-var",
        severity: "error",
        message: `${where}${fieldLabel}: ${issue.message}`,
      });
    }
  }

  return issues;
}

function checkEnvMcpOwners(
  step: StepDefinitionSpec,
): DefinitionValidationIssue[] {
  const serverKeys = Object.keys(step.opencodeMcpJson ?? {}).sort();
  const serverKeySet = new Set(serverKeys);
  const issues: DefinitionValidationIssue[] = [];

  (step.envJson ?? []).forEach((entry, index) => {
    if (entry.source !== "inherit" || entry.mcp === undefined) return;
    if (serverKeySet.has(entry.mcp)) return;
    issues.push({
      check: "env-var-mcp",
      severity: "error",
      message:
        `Step "${step.key}" env var #${String(index + 1)} ("${entry.name}") ` +
        `belongs to MCP server "${entry.mcp}", but the step declares no MCP ` +
        `server with that key. Declared servers: ` +
        `${serverKeys.length > 0 ? listPaths(serverKeys) : "(none)"}.`,
    });
  });

  return issues;
}

function checkEnvApplies(
  step: StepDefinitionSpec,
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  (step.envJson ?? []).forEach((entry, index) => {
    const applies: EnvVarApplies = entry.applies ?? "agent";
    if (applies === "agent") return;
    const where = `Step "${step.key}" env var #${String(index + 1)} ("${entry.name}") applies "${applies}"`;
    if (step.executionMode === "no_workspace") {
      issues.push({
        check: "env-var-applies",
        severity: "error",
        message: `${where}: setup variables reach devcontainer up, but the step runs on the host (executionMode "no_workspace") with no container to set up. Use applies "agent" or Runtime.devcontainer().`,
      });
    }
    if (entry.source === "inherit" && entry.mcp !== undefined) {
      issues.push({
        check: "env-var-applies",
        severity: "error",
        message: `${where}: it belongs to MCP server "${entry.mcp}", and MCP servers run inside the agent. Use applies "agent".`,
      });
    }
  });

  return issues;
}
