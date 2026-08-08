/**
 * The real-execution health check gate (#120): starts the fake-AI harness a
 * health-check-declaring step's forced tool calls run through, and runs
 * those declared checks (#119) against the launched environment, throwing
 * before the agent is ever prompted if a `required` one fails.
 *
 * Split out of `process-claimed-step-execution.ts` to keep that module under
 * the repo's per-file line limit; the two functions here are its only caller.
 */
import type { HealthCheck } from "@boboddy/sdk/health-checks";
import type { ProjectWorkLogger } from "../contracts/process-project-work-types";
import type { WorkReporter } from "../contracts/work-reporter";
import { buildFakeAiProviderOverride, FakeAiServer } from "../infra/fake-ai";
import { HealthCheckFailedError } from "./health-check-failed-error";
import {
  describeFailedHealthCheck,
  findFailedRequiredHealthCheck,
  runHealthChecks,
  type HealthCheckReport,
  type RunHealthChecksInput,
} from "./run-health-checks";

/**
 * Starts the fake-AI harness for a step that declares `healthChecks`,
 * returning the started server plus the `fakeAiProviderOverride` to bake
 * into the runtime launch (see `buildFakeAiProviderOverride`, the same
 * host/port logic `run-work-dry-run.ts`'s dry-run equivalent uses). A step
 * declaring none gets `undefined` for both — no harness starts, no
 * synthetic provider is registered, and the launch stays byte-identical to
 * today.
 */
export async function startHealthCheckHarnessIfDeclared(input: {
  healthChecks: HealthCheck[];
  isNoWorkspace: boolean;
  createFakeAiServer?: (() => FakeAiServer) | undefined;
}): Promise<{
  fakeAiServer: FakeAiServer | undefined;
  fakeAiProviderOverride: { baseUrl: string } | undefined;
}> {
  if (input.healthChecks.length === 0) {
    return { fakeAiServer: undefined, fakeAiProviderOverride: undefined };
  }

  const fakeAiServer = (
    input.createFakeAiServer ?? (() => new FakeAiServer())
  )();
  await fakeAiServer.start();
  return {
    fakeAiServer,
    fakeAiProviderOverride: buildFakeAiProviderOverride({
      fakeAiServer,
      isNoWorkspace: input.isNoWorkspace,
    }),
  };
}

/**
 * Runs a step's declared health checks against the launched environment and
 * throws {@link HealthCheckFailedError} if any `required` check failed. The
 * harness is stopped in a `finally` so it happens exactly once, immediately
 * after the checks complete, regardless of outcome — before the caller's
 * `fakeAiServer` reference needs to be considered "live" again. The forced
 * call's announcement and the tool's output land in the durable log feed for
 * free: the caller attaches the in-container OpenCode log tail before this
 * gate ever runs.
 */
export async function runDeclaredHealthChecksOrThrow(input: {
  fakeAiServer: FakeAiServer;
  agentBaseUrl: string;
  workspaceFolder: string;
  healthChecks: HealthCheck[];
  runHealthChecksOverride?:
    | ((input: RunHealthChecksInput) => Promise<HealthCheckReport[]>)
    | undefined;
  logger: ProjectWorkLogger;
  reporter: WorkReporter;
  stepExecutionId: string;
}): Promise<void> {
  input.reporter.event({
    type: "step:health-checks-running",
    stepExecutionId: input.stepExecutionId,
  });
  input.logger.log("step", "Running declared health checks", {
    stepExecutionId: input.stepExecutionId,
    healthCheckCount: input.healthChecks.length,
  });

  let reports: HealthCheckReport[];
  try {
    reports = await (input.runHealthChecksOverride ?? runHealthChecks)({
      agentBaseUrl: input.agentBaseUrl,
      workspaceFolder: input.workspaceFolder,
      healthChecks: input.healthChecks,
      fakeAiServer: input.fakeAiServer,
    });
  } finally {
    await input.fakeAiServer.stop();
  }

  input.logger.log("step", "Declared health checks completed", {
    stepExecutionId: input.stepExecutionId,
    reports,
  });

  const requiredFailure = findFailedRequiredHealthCheck(reports);
  if (requiredFailure) {
    throw new HealthCheckFailedError(
      describeFailedHealthCheck(
        requiredFailure.report,
        requiredFailure.outcome,
      ),
    );
  }
}
