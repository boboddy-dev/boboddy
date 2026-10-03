import { devcontainerConfigPathSchema } from "../../devcontainer-config-path";
import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Check: a step's `devcontainerConfigPath` satisfies the shared path schema and
 * is only set on a `workspace` step, and a `code` step is not a host
 * (`no_workspace`) step. `Runtime` already makes host plus a config path
 * unrepresentable and guards the path at definition time, and `codeStep`'s
 * types exclude the host runtime; this catches hand-built or generated specs
 * that bypass them.
 */
export function checkRuntime(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    if (step.kind === "code" && step.executionMode === "no_workspace") {
      issues.push({
        check: "runtime",
        severity: "error",
        message: `Step "${step.key}": code steps run repo code and need a workspace, so Runtime.host() (executionMode "no_workspace") is not supported for codeStep. Use Runtime.devcontainer() or drop the runtime.`,
      });
    }

    if (step.devcontainerConfigPath == null) continue;
    const where = `Step "${step.key}" devcontainerConfigPath "${step.devcontainerConfigPath}"`;

    if (step.executionMode === "no_workspace") {
      issues.push({
        check: "runtime",
        severity: "error",
        message: `${where}: a devcontainer config needs a workspace, but the step runs on the host (executionMode "no_workspace"). Use Runtime.devcontainer({ config }) or drop the config.`,
      });
    }

    const result = devcontainerConfigPathSchema.safeParse(
      step.devcontainerConfigPath,
    );
    if (result.success) continue;

    for (const issue of result.error.issues) {
      issues.push({
        check: "runtime",
        severity: "error",
        message: `${where}: ${issue.message}`,
      });
    }
  }

  return issues;
}
