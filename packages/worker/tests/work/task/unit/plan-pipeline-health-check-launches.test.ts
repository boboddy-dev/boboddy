import { describe, expect, test } from "bun:test";
import {
  describeHealthCheckRuntime,
  planHealthCheckLaunches,
  resolveHealthCheckRuntime,
  type HealthCheckStep,
} from "../../../../src/work/task/application/plan-pipeline-health-check-launches";

/**
 * The run-offer gate launches once per distinct runtime. Getting the grouping
 * wrong either wastes a container launch per step, or merges two steps whose
 * configurations disagree, and so tests a server one of them never gets.
 */

function step(
  overrides: Partial<HealthCheckStep> & { key: string },
): HealthCheckStep {
  return {
    stepDefinitionId: `id-${overrides.key}`,
    name: overrides.key,
    executionMode: "workspace",
    devcontainerConfigPath: null,
    managedRuntime: null,
    opencodeMcpJson: null,
    healthChecksJson: [
      {
        kind: "cli",
        command: ["true"],
        expectExitCode: 0,
        severity: "required",
        timeoutSeconds: 15,
      },
    ],
    envJson: null,
    ...overrides,
  };
}

const keysPerLaunch = (steps: HealthCheckStep[]) =>
  planHealthCheckLaunches(steps).launches.map((launch) =>
    launch.steps.map((entry) => entry.key),
  );

describe("resolveHealthCheckRuntime", () => {
  test("a host step ignores the container fields", () => {
    expect(
      resolveHealthCheckRuntime(
        step({
          key: "a",
          executionMode: "no_workspace",
          devcontainerConfigPath: ".devcontainer/x.json",
          managedRuntime: "node-22",
        }),
      ),
    ).toEqual({ kind: "host" });
  });

  test("a managed runtime replaces the devcontainer path", () => {
    expect(
      resolveHealthCheckRuntime(
        step({
          key: "a",
          devcontainerConfigPath: ".devcontainer/x.json",
          managedRuntime: "node-22",
        }),
      ),
    ).toEqual({ kind: "managed", managedRuntime: "node-22" });
  });

  test("names each runtime for the report", () => {
    expect(describeHealthCheckRuntime({ kind: "host" })).toBe("host");
    expect(
      describeHealthCheckRuntime({
        kind: "devcontainer",
        devcontainerConfigPath: null,
      }),
    ).toBe("project devcontainer");
  });
});

describe("planHealthCheckLaunches", () => {
  test("steps with the same runtime share one launch, in pipeline order", () => {
    expect(
      keysPerLaunch([
        step({ key: "a" }),
        step({ key: "b" }),
        step({ key: "c" }),
      ]),
    ).toEqual([["a", "b", "c"]]);
  });

  test("one launch per distinct runtime", () => {
    expect(
      keysPerLaunch([
        step({ key: "host-1", executionMode: "no_workspace" }),
        step({ key: "dev-1" }),
        step({ key: "managed", managedRuntime: "node-22" }),
        step({ key: "dev-2" }),
        step({
          key: "other-dev",
          devcontainerConfigPath: ".devcontainer/b.json",
        }),
        step({ key: "host-2", executionMode: "no_workspace" }),
      ]),
    ).toEqual([
      ["host-1", "host-2"],
      ["dev-1", "dev-2"],
      ["managed"],
      ["other-dev"],
    ]);
  });

  test("skips steps that declare no checks, and launches nothing for them", () => {
    const plan = planHealthCheckLaunches([
      step({
        key: "code",
        executionMode: "no_workspace",
        healthChecksJson: null,
      }),
      step({ key: "empty", healthChecksJson: [] }),
    ]);
    expect(plan.launches).toEqual([]);
    expect(plan.stepsWithoutChecks.map((entry) => entry.key)).toEqual([
      "code",
      "empty",
    ]);
  });

  test("merges MCP servers and env of a shared launch", () => {
    const [launch] = planHealthCheckLaunches([
      step({
        key: "a",
        opencodeMcpJson: { playwright: { type: "ref" } },
        envJson: [
          {
            name: "A",
            source: "inherit",
            from: "A",
            secret: false,
            optional: false,
            applies: "agent",
          },
        ],
      }),
      step({
        key: "b",
        opencodeMcpJson: { playwright: { type: "ref" }, db: { type: "ref" } },
      }),
    ]).launches;
    expect(Object.keys(launch?.opencodeMcpJson ?? {})).toEqual([
      "playwright",
      "db",
    ]);
    expect(launch?.envJson.map((spec) => spec.name)).toEqual(["A"]);
  });

  test("an MCP key defined differently splits the steps into separate launches", () => {
    expect(
      keysPerLaunch([
        step({
          key: "a",
          opencodeMcpJson: { db: { type: "ref", name: "pg-readonly" } },
        }),
        step({
          key: "b",
          opencodeMcpJson: { db: { type: "ref", name: "pg-admin" } },
        }),
        step({
          key: "c",
          opencodeMcpJson: { db: { type: "ref", name: "pg-readonly" } },
        }),
      ]),
    ).toEqual([["a", "c"], ["b"]]);
  });

  test("key order inside a definition is not a conflict", () => {
    expect(
      keysPerLaunch([
        step({
          key: "a",
          opencodeMcpJson: { db: { type: "ref", name: "pg" } },
        }),
        step({
          key: "b",
          opencodeMcpJson: { db: { name: "pg", type: "ref" } },
        }),
      ]),
    ).toEqual([["a", "b"]]);
  });

  test("conflicting env specs also split", () => {
    expect(
      keysPerLaunch([
        step({
          key: "a",
          envJson: [
            {
              name: "URL",
              source: "value",
              value: "x",
              secret: false,
              applies: "agent",
            },
          ],
        }),
        step({
          key: "b",
          envJson: [
            {
              name: "URL",
              source: "value",
              value: "y",
              secret: false,
              applies: "agent",
            },
          ],
        }),
      ]),
    ).toEqual([["a"], ["b"]]);
  });
});
