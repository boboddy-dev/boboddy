import { describe, expect, test } from "bun:test";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpecWithOverrides } from "./definition-spec-fixtures";

/**
 * `validateDefinitionSpecs — runtime`: the `runtime` check runs the shared
 * `devcontainerConfigPathSchema` over hand-built specs that bypass `Runtime`,
 * and rejects a config path on a host (`no_workspace`) step, and any code step
 * on a host runtime.
 */
describe("validateDefinitionSpecs — runtime", () => {
  const validate = (steps: ReturnType<typeof stepSpecWithOverrides>[]) =>
    validateDefinitionSpecs({ pipelines: [], steps });

  test.concurrent("accepts a workspace step with a valid config path", () => {
    expect(
      validate([
        stepSpecWithOverrides("alt", {
          executionMode: "workspace",
          devcontainerConfigPath: ".devcontainer/alt/devcontainer.json",
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("accepts a path with a leading ./", () => {
    expect(
      validate([
        stepSpecWithOverrides("alt", {
          devcontainerConfigPath: "./.devcontainer/alt/devcontainer.json",
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("stays quiet for null, omitted and host-without-path", () => {
    expect(
      validate([
        stepSpecWithOverrides("null-path", { devcontainerConfigPath: null }),
        stepSpecWithOverrides("no-path"),
        stepSpecWithOverrides("host", {
          executionMode: "no_workspace",
          devcontainerConfigPath: null,
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("treats an omitted executionMode as a workspace", () => {
    expect(
      validate([
        stepSpecWithOverrides("alt", {
          devcontainerConfigPath: "devcontainer.json",
        }),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["/etc/devcontainer.json", "relative"],
    ["C:/work/devcontainer.json", "relative"],
    [".devcontainer\\devcontainer.json", "backslash"],
    ["../devcontainer.json", '".."'],
    [".devcontainer/other.json", "devcontainer.json"],
    ["", "devcontainer.json"],
    [`${"a".repeat(260)}/devcontainer.json`, "255"],
  ])("rejects the config path %j", (devcontainerConfigPath, fragment) => {
    const issues = validate([
      stepSpecWithOverrides("bad-path", {
        executionMode: "workspace",
        devcontainerConfigPath,
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain(
      'Step "bad-path" devcontainerConfigPath',
    );
    expect(issues[0]?.message).toContain(fragment);
  });

  test.concurrent("rejects a config path on a no_workspace step", () => {
    const issues = validate([
      stepSpecWithOverrides("host-step", {
        executionMode: "no_workspace",
        devcontainerConfigPath: ".devcontainer/devcontainer.json",
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain('Step "host-step"');
    expect(issues[0]?.message).toContain("no_workspace");
  });

  test.concurrent("rejects a code step on a no_workspace runtime", () => {
    const issues = validate([
      stepSpecWithOverrides("host-code", {
        kind: "code",
        executionMode: "no_workspace",
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("runtime");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain('Step "host-code"');
    expect(issues[0]?.message).toContain("Runtime.host()");
    expect(issues[0]?.message).toContain("codeStep");
  });

  test.concurrent("accepts code steps on a workspace runtime", () => {
    expect(
      validate([
        stepSpecWithOverrides("code-default", { kind: "code" }),
        stepSpecWithOverrides("code-alt", {
          kind: "code",
          executionMode: "workspace",
          devcontainerConfigPath: ".devcontainer/alt/devcontainer.json",
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("still allows a host agent step", () => {
    expect(
      validate([
        stepSpecWithOverrides("host-agent", {
          kind: "user_defined",
          executionMode: "no_workspace",
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("reports both problems for a bad path on a host step", () => {
    const issues = validate([
      stepSpecWithOverrides("both", {
        executionMode: "no_workspace",
        devcontainerConfigPath: "/abs/devcontainer.json",
      }),
    ]);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.check === "runtime")).toBe(true);
  });
});
