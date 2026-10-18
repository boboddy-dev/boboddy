import { describe, expect, test } from "bun:test";
import type { HealthCheck } from "@boboddy/sdk/health-checks";
import type { HealthCheckStep } from "../../../../src/work/task/application/plan-pipeline-health-check-launches";
import {
  listPipelineStepDefinitionIds,
  runPipelineHealthCheckLaunches,
  type HealthCheckLaunchOutcome,
  type RunHealthCheckLaunch,
} from "../../../../src/work/task/application/run-pipeline-health-checks-dry-run";
import {
  computePipelineHealthGateOk,
  listStepHealthCheckFindings,
} from "../../../../src/work/task/application/pipeline-health-check-report";
import type { HealthCheckReport } from "../../../../src/work/task/application/run-health-checks";
import type { DryRunEnvironmentHealth } from "../../../../src/work/task/application/dry-run-environment";

/**
 * The run-offer gate's per-step reporting and blocking, with the launch faked:
 * which launch each step's checks ran in, what each step is told, and which
 * outcomes stop the run offer.
 */

const cliCheck = (
  name: string,
  severity: "required" | "warn",
): HealthCheck => ({
  kind: "cli",
  name,
  command: [name],
  expectExitCode: 0,
  severity,
  timeoutSeconds: 15,
});

function step(
  overrides: Partial<HealthCheckStep> & { key: string },
): HealthCheckStep {
  return {
    stepDefinitionId: `id-${overrides.key}`,
    name: `Step ${overrides.key}`,
    executionMode: "workspace",
    devcontainerConfigPath: null,
    managedRuntime: null,
    opencodeMcpJson: null,
    healthChecksJson: [cliCheck(`${overrides.key}-check`, "required")],
    envJson: null,
    ...overrides,
  };
}

const HEALTHY: DryRunEnvironmentHealth = {
  containerHealth: { status: "running", healthy: true },
  opencodeHealth: { healthy: true },
  mcpServers: [],
};

function report(
  check: HealthCheck,
  outcome: HealthCheckReport["outcome"],
): HealthCheckReport {
  const name = check.name ?? "";
  return {
    name,
    resolvedId: name,
    severity: check.severity,
    kind: check.kind,
    outcome,
  };
}

/** Every check passes unless `failing` names it. */
function fakeLaunch(
  options: {
    failing?: Record<string, HealthCheckReport["outcome"]>;
    health?: DryRunEnvironmentHealth;
    launchFailsFor?: (keys: string[]) => string | undefined;
  } = {},
): { runLaunch: RunHealthCheckLaunch; launches: string[][] } {
  const launches: string[][] = [];
  const runLaunch: RunHealthCheckLaunch = (launch) => {
    const keys = launch.steps.map((entry) => entry.key);
    launches.push(keys);
    const reason = options.launchFailsFor?.(keys);
    if (reason !== undefined) {
      return Promise.resolve({ kind: "launch-failed", reason });
    }
    const outcome: HealthCheckLaunchOutcome = {
      kind: "ran",
      health: options.health ?? HEALTHY,
      healthChecksByStep: new Map(
        launch.steps.map((entry) => [
          entry.stepDefinitionId,
          (entry.healthChecksJson ?? []).map((check) =>
            report(
              check,
              options.failing?.[check.name ?? ""] ?? { kind: "passed" },
            ),
          ),
        ]),
      ),
    };
    return Promise.resolve(outcome);
  };
  return { runLaunch, launches };
}

const failed = (detail: string): HealthCheckReport["outcome"] => ({
  kind: "failed",
  reason: "nonzero-exit",
  detail,
});

describe("listPipelineStepDefinitionIds", () => {
  test("keeps working nodes only, deduped, in position order", () => {
    expect(
      listPipelineStepDefinitionIds([
        { kind: "step", stepDefinitionId: "fix", position: 5 },
        { kind: "choice", stepDefinitionId: "choice-node", position: 2 },
        { kind: "step", stepDefinitionId: "evaluate", position: 1 },
        { kind: "fail", stepDefinitionId: "fail-node", position: 3 },
        { kind: "fanOut", stepDefinitionId: "evaluate", position: 4 },
        { kind: "succeed", stepDefinitionId: "done-node", position: 6 },
      ]),
    ).toEqual(["evaluate", "fix"]);
  });
});

describe("runPipelineHealthCheckLaunches", () => {
  test("one launch per runtime, and every step with checks is reported in pipeline order", async () => {
    const { runLaunch, launches } = fakeLaunch();
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [
        step({
          key: "evaluate",
          executionMode: "no_workspace",
          healthChecksJson: null,
        }),
        step({
          key: "request-details",
          executionMode: "no_workspace",
          healthChecksJson: null,
        }),
        step({ key: "investigate" }),
        step({ key: "failing-test" }),
        step({ key: "fix" }),
      ],
      runLaunch,
    });

    expect(launches).toEqual([["investigate", "failing-test", "fix"]]);
    expect(result.launchCount).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.steps.map((entry) => entry.stepKey)).toEqual([
      "investigate",
      "failing-test",
      "fix",
    ]);
    expect(result.stepsWithoutChecks.map((entry) => entry.stepKey)).toEqual([
      "evaluate",
      "request-details",
    ]);
    expect(result.steps[0]?.runtime).toBe("project devcontainer");
  });

  test("a required failure blocks and is attributed to its own step only", async () => {
    const { runLaunch } = fakeLaunch({
      failing: { "fix-check": failed("vitest: not found") },
    });
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [step({ key: "failing-test" }), step({ key: "fix" })],
      runLaunch,
    });

    expect(result.ok).toBe(false);
    const findings = listStepHealthCheckFindings(result.steps);
    expect(
      findings.map((finding) => [
        finding.stepKey,
        finding.checkName,
        finding.outcome,
        finding.blocking,
      ]),
    ).toEqual([
      ["failing-test", "failing-test-check", "passed", false],
      ["fix", "fix-check", "failed", true],
    ]);
    expect(findings[1]?.message).toBe("[nonzero-exit] vitest: not found");
    expect(findings[1]?.severity).toBe("required");
  });

  test("a warn failure is reported but does not block", async () => {
    const { runLaunch } = fakeLaunch({
      failing: { "playwright-cli": failed("not installed") },
    });
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [
        step({
          key: "investigate",
          healthChecksJson: [
            cliCheck("browser", "required"),
            cliCheck("playwright-cli", "warn"),
          ],
        }),
      ],
      runLaunch,
    });

    expect(result.ok).toBe(true);
    const warned = listStepHealthCheckFindings(result.steps).find(
      (finding) => finding.checkName === "playwright-cli",
    );
    expect(warned).toMatchObject({
      outcome: "failed",
      severity: "warn",
      blocking: false,
    });
  });

  test("a required check skipped after an earlier required failure also blocks", () => {
    expect(
      computePipelineHealthGateOk([
        {
          stepDefinitionId: "id-a",
          stepKey: "a",
          stepName: "A",
          runtime: "host",
          launchError: null,
          environmentProblems: [],
          mcpServers: [],
          healthChecks: [
            report(cliCheck("second", "required"), { kind: "skipped" }),
          ],
        },
      ]),
    ).toBe(false);
  });

  test("a failed launch blocks every step it was for, and not the other runtimes", async () => {
    const { runLaunch, launches } = fakeLaunch({
      launchFailsFor: (keys) =>
        keys.includes("dev") ? "devcontainer build failed" : undefined,
    });
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [
        step({ key: "host", executionMode: "no_workspace" }),
        step({ key: "dev" }),
        step({ key: "dev-2" }),
      ],
      runLaunch,
    });

    expect(launches).toEqual([["host"], ["dev", "dev-2"]]);
    expect(result.ok).toBe(false);
    const blocking = listStepHealthCheckFindings(result.steps).filter(
      (finding) => finding.blocking,
    );
    expect(
      blocking.map((finding) => [finding.stepKey, finding.checkName]),
    ).toEqual([
      ["dev", "environment"],
      ["dev-2", "environment"],
    ]);
    expect(blocking[0]?.message).toBe(
      "project devcontainer failed to launch: devcontainer build failed",
    );
  });

  test("a launch that throws costs only its own steps; later launches still run", async () => {
    const launches: string[][] = [];
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [
        step({ key: "dev" }),
        step({ key: "host", executionMode: "no_workspace" }),
      ],
      runLaunch: (launch) => {
        const keys = launch.steps.map((entry) => entry.key);
        launches.push(keys);
        if (keys.includes("dev"))
          return Promise.reject(new Error("probe crashed"));
        return fakeLaunch().runLaunch(launch);
      },
    });

    expect(launches).toEqual([["dev"], ["host"]]);
    expect(
      result.steps.map((entry) => [entry.stepKey, entry.launchError]),
    ).toEqual([
      ["dev", "probe crashed"],
      ["host", null],
    ]);
  });

  test("an unhealthy OpenCode blocks; a failed MCP handshake is shown but does not", async () => {
    const unhealthy = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [step({ key: "a" })],
      runLaunch: fakeLaunch({
        health: {
          ...HEALTHY,
          opencodeHealth: { healthy: false, detail: "timeout" },
        },
      }).runLaunch,
    });
    expect(unhealthy.ok).toBe(false);
    expect(listStepHealthCheckFindings(unhealthy.steps)[0]).toMatchObject({
      checkName: "environment",
      message: "project devcontainer: OpenCode unhealthy (timeout)",
      blocking: true,
    });

    const handshake = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [
        step({ key: "a", opencodeMcpJson: { db: { type: "ref" } } }),
        step({ key: "b" }),
      ],
      runLaunch: fakeLaunch({
        health: {
          ...HEALTHY,
          mcpServers: [
            {
              name: "db",
              status: "failed",
              error: "ECONNREFUSED",
              healthy: false,
            },
          ],
        },
      }).runLaunch,
    });
    expect(handshake.ok).toBe(true);
    const findings = listStepHealthCheckFindings(handshake.steps).filter(
      (finding) => finding.checkName === "mcp db",
    );
    // Only the step that declares the server is told about its handshake.
    expect(
      findings.map((finding) => [finding.stepKey, finding.blocking]),
    ).toEqual([["a", false]]);
  });
});
