import * as clack from "@clack/prompts";
import { z } from "zod";
import { connectApi, describeApiError } from "./cli-api-client";

/**
 * The real implementations of the run offer's ports: one `clack` confirm and two
 * API calls.
 *
 * Deliberately thin — every branch lives in `design-run-offer.ts`, where it is
 * unit-tested without a terminal or a network. The one exception is
 * {@link readAssignedPipelineId}, which has to compensate for a generated type
 * and so is tested directly.
 */

/**
 * The one field of the assignment the run offer needs.
 *
 * A project's default assignment names exactly one pipeline definition; its
 * `rulesJson` only decides *whether* to assign, never *which*. So the id is
 * readable without evaluating any rules — it is the pipeline the design session
 * just pushed.
 *
 * Parsed rather than read because the generated SDK types nullable fields as
 * `T | unknown`, which TypeScript collapses to plain `unknown`. The compiler
 * offers no help at this boundary, so the schema is the only thing pinning the
 * field name.
 */
export const assignedPipelineSchema = z.object({
  linearPipelineDefinitionId: z.string().min(1),
});

/**
 * The pipeline this project's work items are assigned to. `undefined` when the
 * project has no assignment — which the offer reads as nothing to run.
 */
export async function resolveAssignedPipeline(input: {
  baseUrl: string;
  projectId: string;
}): Promise<string | undefined> {
  const { client, headers } = await connectApi(input.baseUrl);

  const { data, error } = await client.projects.getProject({
    path: { projectId: input.projectId },
    headers,
  });

  if (error !== undefined) {
    throw new Error(`Could not read the project: ${describeApiError(error)}`);
  }

  // Parsed at the boundary, before the id crosses into the offer.
  const assignment = assignedPipelineSchema.safeParse(
    data.defaultPipelineAssignment,
  );
  return assignment.success
    ? assignment.data.linearPipelineDefinitionId
    : undefined;
}

/**
 * Queue a run of `pipelineDefinitionId` against one work item.
 *
 * This is the same call the dashboard's executions drawer makes. It is needed
 * because neither creating a work item nor pushing a pipeline queues anything:
 * the default-assignment policy only fires when a work item is *upserted* by an
 * integration sync, so without this the worker would have nothing to claim.
 *
 * `inputJson` is omitted — the pipeline's input comes from the work item.
 */
export async function queueDesignRun(input: {
  baseUrl: string;
  projectId: string;
  workItemId: string;
  pipelineDefinitionId: string;
}): Promise<void> {
  const { client, headers } = await connectApi(input.baseUrl);

  const { error } = await client.pipelineExecutions.createPipelineExecution({
    body: {
      projectId: input.projectId,
      workItemId: input.workItemId,
      linearPipelineDefinitionId: input.pipelineDefinitionId,
    },
    headers,
  });

  if (error !== undefined) {
    throw new Error(`Could not queue the run: ${describeApiError(error)}`);
  }
}

/**
 * The closing confirm. Defaults to yes: the user just spent a session designing
 * this, and watching it run is the point.
 */
export async function promptRunNow(workItemTitle: string): Promise<boolean> {
  const answer = await clack.confirm({
    message: `Run your new pipeline on “${workItemTitle}” now?`,
    initialValue: true,
  });
  // Cancelling the offer is not a failed session — the pipeline is already
  // pushed. Treated as "not now", so the command prints instead of running.
  return !clack.isCancel(answer) && answer;
}
