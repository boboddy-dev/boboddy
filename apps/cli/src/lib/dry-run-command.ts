import { runWorkDryRun } from "@boboddy/worker";
import { createTransport } from "./logger";
import { resolveDryRunStepSelection } from "./dry-run-step-picker";
import { renderDryRunReport } from "./dry-run-report";
import type { CliReporter } from "./reporter-types";

export type RunWorkDryRunCommandOptions = {
  projectId: string;
  baseUrl: string | undefined;
  stepId: string | undefined;
  globalOnly: boolean;
  /** Preserve the container/workspace after the report instead of tearing down. */
  keep: boolean;
  localEnvVars: Record<string, string>;
  reporter: CliReporter;
  /** The CLI's resolved/overridden current local branch (see `resolveSourceBranch`). */
  sourceBranch: string | null;
};

/**
 * `work --dry-run`'s command body: resolve which step's MCP servers to test
 * (interactive picker, `--step-id`, or `--global-only`), run the environment
 * rehearsal, render the report, and report back whether it was healthy so the
 * caller can decide the process exit code.
 */
export async function runWorkDryRunCommand(
  options: RunWorkDryRunCommandOptions,
): Promise<{ ok: boolean }> {
  const isTty = process.stdin.isTTY && process.stdout.isTTY;
  const selection = await resolveDryRunStepSelection({
    projectId: options.projectId,
    baseUrl: options.baseUrl,
    stepId: options.stepId,
    globalOnly: options.globalOnly,
    isTty,
  });

  const report = await runWorkDryRun({
    projectId: options.projectId,
    baseUrl: options.baseUrl,
    stepDefinitionId:
      selection.kind === "step" ? selection.stepDefinitionId : undefined,
    globalOnly: selection.kind === "global-only",
    keep: options.keep,
    dest: createTransport(),
    localEnvVars: options.localEnvVars,
    reporter: options.reporter,
    sourceBranch: options.sourceBranch,
  });

  renderDryRunReport(report, options.reporter);

  return { ok: report.ok };
}
