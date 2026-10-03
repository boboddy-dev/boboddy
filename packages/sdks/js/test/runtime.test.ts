import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Env, Runtime, codeStep, defineStep } from "../src";
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
});

describe("compileEnvironment", () => {
  test("no environment defaults to a workspace with auto-detect", () => {
    expect(compileEnvironment(undefined)).toEqual({
      executionMode: "workspace",
      devcontainerConfigPath: null,
      envJson: null,
      repo: undefined,
    });
  });

  test("an empty environment defaults to a workspace with auto-detect", () => {
    expect(compileEnvironment({})).toEqual({
      executionMode: "workspace",
      devcontainerConfigPath: null,
      envJson: null,
      repo: undefined,
    });
  });

  test("host derives no_workspace and no config", () => {
    expect(compileEnvironment({ runtime: Runtime.host() })).toEqual({
      executionMode: "no_workspace",
      devcontainerConfigPath: null,
      envJson: null,
      repo: undefined,
    });
  });

  test("devcontainer without config derives workspace and null", () => {
    expect(compileEnvironment({ runtime: Runtime.devcontainer() })).toEqual({
      executionMode: "workspace",
      devcontainerConfigPath: null,
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

  test("defaults to workspace with a null config path", () => {
    const spec = codeStep(base);
    expect(spec.executionMode).toBe("workspace");
    expect(spec.devcontainerConfigPath).toBeNull();
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
  });
});
