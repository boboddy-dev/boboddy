import { devcontainerConfigPathSchema } from "../../devcontainer-config-path";
import {
  isManagedRuntimeId,
  MANAGED_RUNTIME_IDS,
} from "../../managed-runtimes";
import type { StepDefinitionSpec } from "../steps/define-step";
import type { DefinitionValidationIssue } from "./validation-issue";

/**
 * Check: a step's `devcontainerConfigPath` satisfies the shared path schema and
 * is only set on a `workspace` step, a `code` step is not a host
 * (`no_workspace`) step, and a step's `managedRuntime` is valid (see
 * `checkManagedRuntime`). `Runtime` already makes host plus a config path
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
        message: `Step "${step.key}": code steps run repo code and need a workspace, so Runtime.host() (executionMode "no_workspace") is not supported for codeStep. Use Runtime.managed.<id>() or Runtime.devcontainer(), or drop the runtime.`,
      });
    }

    issues.push(...checkManagedRuntime(step));

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

/**
 * A step's `managedRuntime` is a known identifier and is only set on a `code`
 * step that runs in a workspace with no devcontainer config. Kept as one
 * function so the code-step-only rule can relax in one place.
 */
function checkManagedRuntime(
  step: StepDefinitionSpec,
): DefinitionValidationIssue[] {
  if (step.managedRuntime == null) return [];

  const where = `Step "${step.key}" managedRuntime "${step.managedRuntime}"`;
  const problems: string[] = [];

  if (!isManagedRuntimeId(step.managedRuntime)) {
    problems.push(
      `unknown managed runtime; expected one of ${MANAGED_RUNTIME_IDS.join(", ")}`,
    );
  }
  if (step.kind !== "code") {
    problems.push(
      "managed runtimes are only supported for code steps. Use Runtime.devcontainer() or Runtime.host() for defineStep",
    );
  }
  if (step.executionMode === "no_workspace") {
    problems.push(
      'a managed runtime needs a workspace, but the step runs on the host (executionMode "no_workspace")',
    );
  }
  if (step.devcontainerConfigPath != null) {
    problems.push(
      "cannot be combined with devcontainerConfigPath. Use either Runtime.managed.<id>() or Runtime.devcontainer({ config })",
    );
  }

  return problems.map((problem) => ({
    check: "runtime",
    severity: "error",
    message: `${where}: ${problem}.`,
  }));
}
