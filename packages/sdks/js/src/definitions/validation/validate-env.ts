import { envVarsSchema } from "../../env-vars";
import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Check: a step's declared env vars satisfy the `envVarsSchema` wire schema
 * (names, reserved names, secret rules, size caps). The authoring helpers
 * (`Env`, `normalizeEnv`) already guard the common mistakes at definition
 * time; this catches hand-built or generated specs that bypass them.
 */
export function checkEnv(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    if (!step.envJson) continue;
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
