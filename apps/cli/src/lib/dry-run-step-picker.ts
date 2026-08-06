import * as clack from "@clack/prompts";
import { ConfigurationError, listProjectStepDefinitionsForDryRun } from "@boboddy/worker";

/** A sentinel `clack.select` value distinct from any real step definition id. */
const GLOBAL_ONLY_CHOICE = "__boboddy_dry_run_global_only__";

export type DryRunStepSelection =
  | { kind: "step"; stepDefinitionId: string }
  | { kind: "global-only" };

/**
 * Resolve which step's MCP servers `work --dry-run` should inject, per the
 * decided precedence:
 *
 *   1. `--step-id` wins outright.
 *   2. `--global-only` wins outright.
 *   3. No step definitions exist for the project yet (e.g. onboarding, before
 *      any pipeline is authored) → behave as `--global-only`.
 *   4. Interactive TTY → prompt the user to pick one (or opt into global-only).
 *   5. Non-interactive (CI) → fail fast with the available step ids rather
 *      than silently guessing.
 */
export async function resolveDryRunStepSelection(input: {
  projectId: string;
  baseUrl: string | undefined;
  stepId: string | undefined;
  globalOnly: boolean;
  isTty: boolean;
}): Promise<DryRunStepSelection> {
  if (input.stepId) {
    return { kind: "step", stepDefinitionId: input.stepId };
  }
  if (input.globalOnly) {
    return { kind: "global-only" };
  }

  const steps = await listProjectStepDefinitionsForDryRun({
    projectId: input.projectId,
    baseUrl: input.baseUrl,
  });

  if (steps.length === 0) {
    return { kind: "global-only" };
  }

  if (!input.isTty) {
    const available = steps.map((step) => `${step.key} (${step.id})`).join(", ");
    throw new ConfigurationError(
      "Multiple steps are available for this project: " +
        `${available}. Pass --step-id <id> or --global-only in ` +
        "non-interactive contexts.",
    );
  }

  const answer = await clack.select({
    message:
      "Which step's MCP servers should the dry run test? (Ctrl+C to cancel)",
    options: [
      ...steps.map((step) => ({
        value: step.id,
        label: step.name,
        hint: step.key,
      })),
      {
        value: GLOBAL_ONLY_CHOICE,
        label: "None — just check whatever's already configured",
        hint: "--global-only",
      },
    ],
  });

  if (clack.isCancel(answer)) {
    throw new ConfigurationError("Dry run cancelled.");
  }

  return answer === GLOBAL_ONLY_CHOICE
    ? { kind: "global-only" }
    : { kind: "step", stepDefinitionId: answer };
}
