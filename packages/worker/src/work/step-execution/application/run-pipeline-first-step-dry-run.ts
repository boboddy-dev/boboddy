import { createBoboddyClient } from "@boboddy/sdk";
import { ConfigurationError } from "../../../lib/errors";
import { resolveBoboddyBaseUrl } from "../../../auth/session/infra/auth-config";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import {
  runWorkDryRun,
  type WorkDryRunOptions,
  type WorkDryRunReport,
} from "./run-work-dry-run";

/**
 * Invocation 2 of the extended `work --dry-run` (#146; see `run-work-dry-run.ts`
 * for invocation 1's `--global-only` scope): a **pipeline id**, not an
 * ambiguous step id, resolved to its ordered step list so the dry run can
 * unambiguously target the first step.
 *
 * Deliberately does not validate every step — see the module doc on
 * {@link resolveFirstStepDefinitionId} for why only the first step is safe to
 * check here.
 */

type PipelineStepForOrdering = {
  stepDefinitionId: string;
  position: number;
};

/**
 * Pick the first step of a pipeline by its server-assigned `position`.
 *
 * The server already returns `stepDefinitions` in position order (every
 * repository backing this contract sorts by `position` before returning), but
 * this re-sorts defensively rather than trusting response order — it costs
 * nothing and this is the one place "first" has to be right.
 *
 * Only the first step, never the whole pipeline: validating every step in one
 * dry-run launch is out of scope for #146, blocked on pre-existing gaps this
 * ticket must not paper over — silent MCP-key merge collisions across steps,
 * health-check abort semantics that would cross-contaminate one step's
 * failure into another's, and mixed workspace/no_workspace execution modes
 * having no single launch to merge into. First-step validation is sufficient
 * to avoid queueing an obviously-broken run without pretending to be more.
 */
export function resolveFirstStepDefinitionId(
  pipelineDefinitionId: string,
  stepDefinitions: readonly PipelineStepForOrdering[],
): string {
  if (stepDefinitions.length === 0) {
    throw new ConfigurationError(
      `Pipeline ${pipelineDefinitionId} has no steps to dry-run.`,
    );
  }
  const [first] = [...stepDefinitions].sort(
    (left, right) => left.position - right.position,
  );
  // Non-null by the length check above; narrows for strict mode.
  return (first as PipelineStepForOrdering).stepDefinitionId;
}

async function fetchFirstStepDefinitionId(
  client: ReturnType<typeof createBoboddyClient>,
  headers: { Authorization: string },
  pipelineDefinitionId: string,
): Promise<string> {
  const result = await client.pipelineDefinitions.getPipelineDefinition({
    path: { linearPipelineDefinitionId: pipelineDefinitionId },
    headers,
  });
  const data = result.data as
    { stepDefinitions: PipelineStepForOrdering[] } | undefined;
  if (!data) {
    throw new ConfigurationError(
      `Pipeline definition ${pipelineDefinitionId} was not found.`,
    );
  }
  return resolveFirstStepDefinitionId(
    pipelineDefinitionId,
    data.stepDefinitions,
  );
}

export type PipelineFirstStepDryRunOptions = Omit<
  WorkDryRunOptions,
  "stepDefinitionId" | "globalOnly"
> & {
  /** The pipeline to resolve to its first step — not a step id. */
  pipelineDefinitionId: string;
};

/**
 * Resolve `pipelineDefinitionId` to its first step (by `position`), then run
 * the full environment rehearsal against it — container, OpenCode, MCP
 * servers, and declared health checks. Comprehensive, unlike invocation 1's
 * `--global-only` scope, because this runs post-push: step-specific
 * configuration exists by now.
 */
export async function runPipelineFirstStepDryRun(
  options: PipelineFirstStepDryRunOptions,
): Promise<WorkDryRunReport> {
  const baseUrl = resolveBoboddyBaseUrl(options.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new ConfigurationError(`Not signed in to ${baseUrl}.`);
  }
  const headers = {
    Authorization: `Bearer ${authenticated.profile.accessToken}`,
  };
  const client = createBoboddyClient(baseUrl);
  const stepDefinitionId = await fetchFirstStepDefinitionId(
    client,
    headers,
    options.pipelineDefinitionId,
  );

  return runWorkDryRun({ ...options, baseUrl, stepDefinitionId });
}
