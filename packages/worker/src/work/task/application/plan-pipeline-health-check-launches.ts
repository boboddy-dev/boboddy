import type { EnvVarSpec } from "@boboddy/sdk/env-vars";
import type { HealthCheck } from "@boboddy/sdk/health-checks";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";

/**
 * Plans how the post-push run-offer gate runs every step's health checks
 * with as few launches as possible: one launch per distinct runtime.
 *
 * **Distinct runtime** means a different answer to "what container (or host
 * process) would a real run of this step start?", which a step definition
 * states in three fields, normalised the way the orchestrators read them:
 *
 * - `executionMode: "no_workspace"`: the host. The orchestrator ignores
 *   `devcontainerConfigPath` and `managedRuntime`, so every host step shares
 *   one runtime.
 * - `managedRuntime` set: that managed image. It replaces the clone's
 *   devcontainer config, so `devcontainerConfigPath` is ignored.
 * - otherwise: the project's devcontainer at `devcontainerConfigPath`, where
 *   `null` (auto-detect) is its own runtime. Whether it resolves to the same
 *   file as an explicit path is only knowable after cloning.
 *
 * Two steps with the same runtime still need separate launches when the
 * launch's merged configuration would change what one of them sees: the
 * same `mcpServers` key with a different definition, or the same env var name
 * with a different spec.
 * Merging those silently would test a server one step never gets. Such a step
 * goes into the next launch of that runtime that has no conflict, or a new one.
 *
 * Steps with no declared checks are not launched at all; code steps never
 * declare any. Pure, so the grouping is unit-tested without a launch.
 */

export type HealthCheckStep = {
  stepDefinitionId: string;
  key: string;
  name: string;
  executionMode: "workspace" | "no_workspace";
  devcontainerConfigPath: string | null;
  managedRuntime: string | null;
  opencodeMcpJson: OpenCodeMcpServers | null;
  healthChecksJson: HealthCheck[] | null;
  envJson: EnvVarSpec[] | null;
};

export type HealthCheckRuntime =
  | { kind: "host" }
  | { kind: "managed"; managedRuntime: string }
  | { kind: "devcontainer"; devcontainerConfigPath: string | null };

export type PlannedHealthCheckLaunch = {
  runtime: HealthCheckRuntime;
  /** In pipeline order; every one declares at least one check. */
  steps: HealthCheckStep[];
  opencodeMcpJson: OpenCodeMcpServers;
  envJson: EnvVarSpec[];
};

export type HealthCheckLaunchPlan = {
  launches: PlannedHealthCheckLaunch[];
  /** Steps that declare no checks, so nothing runs for them. */
  stepsWithoutChecks: HealthCheckStep[];
};

export function resolveHealthCheckRuntime(
  step: HealthCheckStep,
): HealthCheckRuntime {
  if (step.executionMode === "no_workspace") return { kind: "host" };
  if (step.managedRuntime !== null) {
    return { kind: "managed", managedRuntime: step.managedRuntime };
  }
  return {
    kind: "devcontainer",
    devcontainerConfigPath: step.devcontainerConfigPath,
  };
}

export function describeHealthCheckRuntime(
  runtime: HealthCheckRuntime,
): string {
  switch (runtime.kind) {
    case "host":
      return "host";
    case "managed":
      return `managed runtime ${runtime.managedRuntime}`;
    case "devcontainer":
      return runtime.devcontainerConfigPath === null
        ? "project devcontainer"
        : `devcontainer ${runtime.devcontainerConfigPath}`;
  }
}

/** JSON with object keys sorted, so equal definitions compare equal. */
// eslint-disable-next-line local/no-unknown-parameter-type -- serializes already-parsed definitions, not a real input boundary
function canonicalJson(value: unknown): string {
  // eslint-disable-next-line local/no-unknown-parameter-type -- JSON.stringify replacer receives arbitrary nested values
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : nested,
  );
}

/** Entries of `incoming` whose key is already in `existing` with a different value. */
function conflictsByKey<T>(
  existing: ReadonlyMap<string, T>,
  incoming: ReadonlyMap<string, T>,
): boolean {
  for (const [key, value] of incoming) {
    const current = existing.get(key);
    if (
      current !== undefined &&
      canonicalJson(current) !== canonicalJson(value)
    ) {
      return true;
    }
  }
  return false;
}

const mcpEntries = (step: HealthCheckStep) =>
  new Map(Object.entries(step.opencodeMcpJson ?? {}));

const envEntries = (step: HealthCheckStep) =>
  new Map((step.envJson ?? []).map((spec) => [spec.name, spec]));

type LaunchBuilder = {
  runtimeKey: string;
  runtime: HealthCheckRuntime;
  steps: HealthCheckStep[];
  mcp: Map<string, OpenCodeMcpServers[string]>;
  env: Map<string, EnvVarSpec>;
};

function fits(builder: LaunchBuilder, step: HealthCheckStep): boolean {
  return (
    !conflictsByKey(builder.mcp, mcpEntries(step)) &&
    !conflictsByKey(builder.env, envEntries(step))
  );
}

function addStep(builder: LaunchBuilder, step: HealthCheckStep): void {
  builder.steps.push(step);
  for (const [key, value] of mcpEntries(step)) builder.mcp.set(key, value);
  for (const [key, value] of envEntries(step)) builder.env.set(key, value);
}

/** Group `steps` (in pipeline order) into the launches that run their checks. */
export function planHealthCheckLaunches(
  steps: readonly HealthCheckStep[],
): HealthCheckLaunchPlan {
  const builders: LaunchBuilder[] = [];
  const stepsWithoutChecks: HealthCheckStep[] = [];

  for (const step of steps) {
    if ((step.healthChecksJson ?? []).length === 0) {
      stepsWithoutChecks.push(step);
      continue;
    }
    const runtime = resolveHealthCheckRuntime(step);
    const runtimeKey = canonicalJson(runtime);
    let builder = builders.find(
      (candidate) =>
        candidate.runtimeKey === runtimeKey && fits(candidate, step),
    );
    if (!builder) {
      builder = {
        runtimeKey,
        runtime,
        steps: [],
        mcp: new Map(),
        env: new Map(),
      };
      builders.push(builder);
    }
    addStep(builder, step);
  }

  return {
    launches: builders.map((builder) => ({
      runtime: builder.runtime,
      steps: builder.steps,
      opencodeMcpJson: Object.fromEntries(builder.mcp),
      envJson: [...builder.env.values()],
    })),
    stepsWithoutChecks,
  };
}
