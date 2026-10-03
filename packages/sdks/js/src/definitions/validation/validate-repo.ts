import { repoConfigInputSchema, repoRuntimeMismatch } from "../../repo-config";
import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Check: a step's `repo` satisfies `repoConfigInputSchema` (shape, commit
 * message length, single line, `{{input.…}}` / `{{result.…}}` tokens only) and
 * suits its runtime: `readOnly` and `readWrite` need a clone, so they are
 * rejected on a host (`no_workspace`) step, and `none` is rejected on a
 * `workspace` step, which reads its devcontainer config from the clone. The
 * authoring helpers (`Repo`, `compileRepo`) and `StepEnvironment`'s types
 * already guard these at definition time; this catches hand-built or generated
 * specs that bypass them.
 */
export function checkRepo(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    if (!step.repo) continue;
    const where = `Step "${step.key}" repo`;

    const parsed = repoConfigInputSchema.safeParse(step.repo);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.map(String).join(".");
        issues.push({
          check: "repo",
          severity: "error",
          message: `${where}${field ? ` ${field}` : ""}: ${issue.message}`,
        });
      }
      continue;
    }

    const executionMode = step.executionMode ?? "workspace";
    const mismatch = repoRuntimeMismatch(executionMode, parsed.data.mode);
    if (mismatch === null) continue;

    issues.push({
      check: "repo",
      severity: "error",
      message: `${where} "${parsed.data.mode}" cannot be used with executionMode "${executionMode}": ${mismatch}.`,
    });
  }

  return issues;
}
