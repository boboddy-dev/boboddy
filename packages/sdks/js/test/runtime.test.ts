import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Env, Repo, Runtime, codeStep, defineStep } from "../src";
import {
  DEFAULT_CODE_STEP_RUNTIME_ID,
  MANAGED_RUNTIME_IDS,
  managedRuntimeIdSchema,
} from "../src/managed-runtimes";
import { compileEnvironment } from "../src/definitions/steps/runtime";
import { validateDefinitionSpecs } from "../src/definitions/validation";

describe("Runtime constructors", () => {
  test("devcontainer() without options has no config", () => {
    expect(Runtime.devcontainer()).toEqual({ kind: "devcontainer" });
    expect(Runtime.devcontainer({})).toEqual({ kind: "devcontainer" });
  });

  test("devcontainer({ config }) keeps the path", () => {
    expect(
      Runtime.devcontainer({
        config: ".devcontainer/frontend/devcontainer.json",
      }),
    ).toEqual({
      kind: "devcontainer",
      config: ".devcontainer/frontend/devcontainer.json",
    });
  });

  test("devcontainer({ config }) normalizes a leading ./", () => {
    expect(
      Runtime.devcontainer({ config: "./.devcontainer/alt/devcontainer.json" }),
    ).toEqual({
      kind: "devcontainer",
      config: ".devcontainer/alt/devcontainer.json",
    });
  });

  test.each([
    ["/abs/devcontainer.json", "relative"],
    ["C:\\x\\devcontainer.json", "backslash"],
    ["../devcontainer.json", '".."'],
    [".devcontainer/other.json", "devcontainer.json"],
    ["", "devcontainer.json"],
  ])("devcontainer rejects %j at definition time", (config, fragment) => {
    expect(() => Runtime.devcontainer({ config })).toThrow(fragment);
  });

  test("the rejection names the offending path", () => {
    expect(() =>
      Runtime.devcontainer({ config: "../x/devcontainer.json" }),
    ).toThrow(/Runtime\.devcontainer config "\.\.\/x\/devcontainer\.json"/);
  });

  test("host() takes no options and has no config", () => {
    expect(Runtime.host()).toEqual({ kind: "host" });
    // @ts-expect-error host takes no options
    Runtime.host({ config: ".devcontainer/devcontainer.json" });
  });

  test("managed has one factory per registry identifier", () => {
    expect(Object.keys(Runtime.managed)).toEqual([...MANAGED_RUNTIME_IDS]);
    expect(Runtime.managed.bun1()).toEqual({ kind: "managed", id: "bun1" });
    expect(Runtime.managed.node24()).toEqual({ kind: "managed", id: "node24" });
  });

  test("managed rejects an unknown identifier at the type level", () => {
    // @ts-expect-error nope is not a managed runtime identifier
    expect(Runtime.managed.nope).toBeUndefined();
  });

  test("the default code step runtime is a registered identifier", () => {
    expect(MANAGED_RUNTIME_IDS).toContain(DEFAULT_CODE_STEP_RUNTIME_ID);
    expect(DEFAULT_CODE_STEP_RUNTIME_ID).toBe("bun1");
  });
});

describe("managed runtime registry", () => {
  test("lists bun1 and node24", () => {
    expect([...MANAGED_RUNTIME_IDS]).toEqual(["bun1", "node24"]);
  });

  test("schema accepts known identifiers and rejects others", () => {
    expect(managedRuntimeIdSchema.safeParse("bun1").success).toBe(true);
    expect(managedRuntimeIdSchema.safeParse("node24").success).toBe(true);
    expect(managedRuntimeIdSchema.safeParse("bun2").success).toBe(false);
    expect(managedRuntimeIdSchema.safeParse(null).success).toBe(false);
  });
});

describe("compileEnvironment", () => {
  test("no environment defaults to a workspace with auto-detect", () => {
    expect(compileEnvironment(undefined)).toEqual({
      executionMode: "workspace",
      devcontainerConfigPath: null,
      managedRuntime: null,
      envJson: null,
      repo: undefined,
    });
  });

  test("an empty environment defaults to a workspace with auto-detect", () => {
    expect(compileEnvironment({})).toEqual({
      executionMode: "workspace",
      devcontainerConfigPath: null,
      managedRuntime: null,
      envJson: null,
      repo: undefined,
    });
  });

  test("host derives no_workspace and no config", () => {
    expect(compileEnvironment({ runtime: Runtime.host() })).toEqual({
      executionMode: "no_workspace",
      devcontainerConfigPath: null,
      managedRuntime: null,
      envJson: null,
      repo: undefined,
    });
  });

  test("devcontainer without config derives workspace and null", () => {
    expect(compileEnvironment({ runtime: Runtime.devcontainer() })).toEqual({
      executionMode: "workspace",
      devcontainerConfigPath: null,
      managedRuntime: null,
      envJson: null,
      repo: undefined,
    });
  });

  test("devcontainer with config derives workspace and the path", () => {
    expect(
      compileEnvironment({
        runtime: Runtime.devcontainer({ config: "tools/devcontainer.json" }),
      }),
    ).toMatchObject({
      executionMode: "workspace",
      devcontainerConfigPath: "tools/devcontainer.json",
    });
  });

  test("managed derives workspace, the identifier and no config path", () => {
    expect(
      compileEnvironment({
        runtime: Runtime.managed.node24(),
        repo: Repo.readOnly(),
      }),
    ).toEqual({
      executionMode: "workspace",
      devcontainerConfigPath: null,
      managedRuntime: "node24",
      envJson: null,
      repo: { mode: "readOnly" },
    });
  });

  test("defaultRuntime applies only when no runtime is declared", () => {
    const defaultRuntime = Runtime.managed.bun1();
    expect(
      compileEnvironment(undefined, { defaultRuntime }).managedRuntime,
    ).toBe("bun1");
    expect(compileEnvironment({}, { defaultRuntime }).managedRuntime).toBe(
      "bun1",
    );
    expect(
      compileEnvironment(
        { runtime: Runtime.devcontainer() },
        { defaultRuntime },
      ).managedRuntime,
    ).toBeNull();
    expect(
      compileEnvironment(
        { runtime: Runtime.managed.node24() },
        { defaultRuntime },
      ).managedRuntime,
    ).toBe("node24");
  });

  test("vars compile through normalizeEnv", () => {
    expect(
      compileEnvironment({ vars: () => ({ A: "x", B: Env.inherit() }) })
        .envJson,
    ).toEqual([
      { name: "A", source: "value", value: "x", secret: false },
      {
        name: "B",
        source: "inherit",
        from: "B",
        secret: false,
        optional: false,
      },
    ]);
  });
});

describe("defineStep — runtime", () => {
  const base = { key: "s", name: "S", agentPrompt: "go" } as const;

  test("defaults to workspace with a null config path", () => {
    const spec = defineStep(base);
    expect(spec.executionMode).toBe("workspace");
    expect(spec.devcontainerConfigPath).toBeNull();
    expect(spec.managedRuntime).toBeUndefined();
  });

  test("a managed runtime is a type error and fails validation", () => {
    const spec = defineStep({
      ...base,
      // @ts-expect-error managed runtimes are for codeStep only
      environment: { runtime: Runtime.managed.bun1() },
    });
    const issues = validateDefinitionSpecs({ pipelines: [], steps: [spec] });
    expect(spec.managedRuntime).toBe("bun1");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.message).toContain("only supported for code steps");
  });

  test("Runtime.host() emits no_workspace", () => {
    const spec = defineStep({
      ...base,
      environment: { runtime: Runtime.host() },
    });
    expect(spec.executionMode).toBe("no_workspace");
    expect(spec.devcontainerConfigPath).toBeNull();
  });

  test("Runtime.devcontainer({ config }) emits workspace and the path", () => {
    const spec = defineStep({
      ...base,
      environment: {
        runtime: Runtime.devcontainer({
          config: ".devcontainer/frontend/devcontainer.json",
        }),
      },
    });
    expect(spec.executionMode).toBe("workspace");
    expect(spec.devcontainerConfigPath).toBe(
      ".devcontainer/frontend/devcontainer.json",
    );
  });
});

describe("codeStep — runtime", () => {
  const base = { key: "c", name: "C", fn: () => ({}) } as const;

  test("defaults to workspace on the default managed runtime", () => {
    const spec = codeStep(base);
    expect(spec.executionMode).toBe("workspace");
    expect(spec.devcontainerConfigPath).toBeNull();
    expect(spec.managedRuntime).toBe(DEFAULT_CODE_STEP_RUNTIME_ID);
  });

  test("Runtime.managed.<id>() emits workspace and the identifier", () => {
    const spec = codeStep({
      ...base,
      environment: { runtime: Runtime.managed.node24() },
    });
    expect(spec.executionMode).toBe("workspace");
    expect(spec.devcontainerConfigPath).toBeNull();
    expect(spec.managedRuntime).toBe("node24");
  });

  test("Runtime.devcontainer() opts out of the managed default", () => {
    const spec = codeStep({
      ...base,
      environment: { runtime: Runtime.devcontainer() },
    });
    expect(spec.executionMode).toBe("workspace");
    expect(spec.managedRuntime).toBeNull();
  });

  test("Runtime.host() is a type error and fails validation", () => {
    const spec = codeStep({
      ...base,
      // @ts-expect-error code steps need a workspace, so host is unsupported
      environment: { runtime: Runtime.host() },
    });
    const issues = validateDefinitionSpecs({ pipelines: [], steps: [spec] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.message).toContain("codeStep");
  });

  test("Runtime.devcontainer({ config }) emits workspace and the path", () => {
    const spec = codeStep({
      ...base,
      inputSchema: z.object({}),
      environment: {
        runtime: Runtime.devcontainer({ config: "ci/devcontainer.json" }),
      },
    });
    expect(spec.executionMode).toBe("workspace");
    expect(spec.devcontainerConfigPath).toBe("ci/devcontainer.json");
    expect(spec.managedRuntime).toBeNull();
  });

  test("a managed code step passes validation", () => {
    const spec = codeStep({
      ...base,
      environment: { runtime: Runtime.managed.bun1(), repo: Repo.readOnly() },
    });
    expect(validateDefinitionSpecs({ pipelines: [], steps: [spec] })).toEqual(
      [],
    );
  });
});
