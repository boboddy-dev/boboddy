import {
  runPipelineFirstStepDryRun,
  runWorkDryRun,
  type WorkDryRunReport,
} from "@boboddy/worker";
import { createTransport } from "./logger";
import { resolveDryRunStepSelection } from "./dry-run-step-picker";
import { renderDryRunReport } from "./dry-run-report";
import type { CliReporter } from "./reporter-types";

export type RunWorkDryRunCommandOptions = {
  projectId: string;
  baseUrl: string | undefined;
  stepId: string | undefined;
  globalOnly: boolean;
  /**
   * Resolve this pipeline id to its first step and test that — unambiguous by
   * construction, unlike `stepId`. Wins outright over `stepId`/`globalOnly`.
   */
  pipelineId: string | undefined;
  /** Preserve the container/workspace after the report instead of tearing down. */
  keep: boolean;
  localEnvVars: Record<string, string>;
  reporter: CliReporter;
  /** The CLI's resolved/overridden current local branch (see `resolveSourceBranch`). */
  sourceBranch: string | null;
};

/**
 * Render a report through the reporter and reduce it to the one thing the
 * caller needs to decide a process exit code — shared by both branches below
 * so rendering and the `{ ok }` reduction can't drift between them.
 */
function renderAndConclude(
  report: WorkDryRunReport,
  reporter: CliReporter,
): { ok: boolean } {
  renderDryRunReport(report, reporter);
  return { ok: report.ok };
}

/**
 * `work --dry-run`'s command body: resolve which step's MCP servers to test
 * (`--pipeline-id`, interactive picker, `--step-id`, or `--global-only`), run
 * the environment rehearsal, render the report, and report back whether it
 * was healthy so the caller can decide the process exit code.
 */
export async function runWorkDryRunCommand(
  options: RunWorkDryRunCommandOptions,
): Promise<{ ok: boolean }> {
  // A pipeline id resolves to exactly one step (its first, by position) with
  // no ambiguity to resolve — it skips the picker entirely rather than
  // pre-selecting a rung in it.
  if (options.pipelineId) {
    const report = await runPipelineFirstStepDryRun({
      projectId: options.projectId,
      baseUrl: options.baseUrl,
      pipelineDefinitionId: options.pipelineId,
      keep: options.keep,
      dest: createTransport(),
      localEnvVars: options.localEnvVars,
      reporter: options.reporter,
      sourceBranch: options.sourceBranch,
    });
    return renderAndConclude(report, options.reporter);
  }

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

  return renderAndConclude(report, options.reporter);
}
