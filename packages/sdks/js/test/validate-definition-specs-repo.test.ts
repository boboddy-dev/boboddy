import { describe, expect, test } from "bun:test";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpecWithOverrides } from "./definition-spec-fixtures";

/**
 * `validateDefinitionSpecs — repo`: the `repo` check runs `repoConfigInputSchema`
 * over hand-built specs that bypass `Repo`, and enforces the runtime pairing.
 */
describe("validateDefinitionSpecs — repo", () => {
  const validate = (steps: ReturnType<typeof stepSpecWithOverrides>[]) =>
    validateDefinitionSpecs({ pipelines: [], steps });

  test.concurrent("accepts every valid pair", () => {
    expect(
      validate([
        stepSpecWithOverrides("rw", {
          executionMode: "workspace",
          repo: { mode: "readWrite", message: "fix: {{result.summary}}" },
        }),
        stepSpecWithOverrides("ro", {
          executionMode: "workspace",
          repo: { mode: "readOnly" },
        }),
        stepSpecWithOverrides("host", {
          executionMode: "no_workspace",
          repo: { mode: "none" },
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("treats an omitted executionMode as a workspace", () => {
    expect(
      validate([stepSpecWithOverrides("s", { repo: { mode: "readOnly" } })]),
    ).toEqual([]);
    const issues = validate([
      stepSpecWithOverrides("s", { repo: { mode: "none" } }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('executionMode "workspace"');
  });

  test.concurrent("stays quiet for an omitted repo", () => {
    expect(
      validate([
        stepSpecWithOverrides("a"),
        stepSpecWithOverrides("b", { executionMode: "no_workspace" }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("accepts a resolved repo sent back as input", () => {
    expect(
      validate([
        stepSpecWithOverrides("s", {
          repo: { mode: "readWrite", message: null, onPushFailure: "fail" },
        }),
      ]),
    ).toEqual([]);
  });

  test.each([
    [{ mode: "readWrite" }, "readWrite"],
    [{ mode: "readOnly" }, "readOnly"],
  ] as const)("rejects %j on a no_workspace step", (repo, mode) => {
    const issues = validate([
      stepSpecWithOverrides("host-step", {
        executionMode: "no_workspace",
        repo,
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain('Step "host-step"');
    expect(issues[0]?.message).toContain(`"${mode}"`);
    expect(issues[0]?.message).toContain('"no_workspace"');
    expect(issues[0]?.message).toContain("a host step has no clone");
  });

  test.concurrent("rejects none on a workspace step", () => {
    const issues = validate([
      stepSpecWithOverrides("dev-step", {
        executionMode: "workspace",
        repo: { mode: "none" },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain('Step "dev-step"');
    expect(issues[0]?.message).toContain('"none"');
    expect(issues[0]?.message).toContain('"workspace"');
    expect(issues[0]?.message).toContain(
      "a devcontainer step reads its config from the clone",
    );
  });

  test.concurrent("rejects a code step with none (workspace)", () => {
    const issues = validate([
      stepSpecWithOverrides("code", { kind: "code", repo: { mode: "none" } }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
  });

  test.concurrent("rejects an env token in the message", () => {
    const issues = validate([
      stepSpecWithOverrides("leaky", {
        repo: { mode: "readWrite", message: "deploy {{env.API_TOKEN}}" },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
    expect(issues[0]?.message).toContain('Step "leaky" repo message');
    expect(issues[0]?.message).toContain("tokens");
  });

  test.concurrent("rejects a newline in the message", () => {
    const issues = validate([
      stepSpecWithOverrides("multi", {
        repo: { mode: "readWrite", message: "one\ntwo" },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("single line");
  });

  test.concurrent("rejects a message over 500 characters", () => {
    const issues = validate([
      stepSpecWithOverrides("long", {
        repo: { mode: "readWrite", message: "a".repeat(501) },
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
    expect(issues[0]?.message).toContain('Step "long" repo message');
  });

  test.concurrent("rejects a message on readOnly", () => {
    const issues = validate([
      stepSpecWithOverrides("ro", {
        repo: { mode: "readOnly", message: "x" } as never,
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("repo");
  });

  test.concurrent(
    "rejects an unknown mode and an unknown onPushFailure",
    () => {
      const badMode = validate([
        stepSpecWithOverrides("m", { repo: { mode: "write" } as never }),
      ]);
      expect(badMode).toHaveLength(1);
      expect(badMode[0]?.check).toBe("repo");

      const badPush = validate([
        stepSpecWithOverrides("p", {
          repo: { mode: "readWrite", onPushFailure: "ignore" } as never,
        }),
      ]);
      expect(badPush).toHaveLength(1);
      expect(badPush[0]?.message).toContain('Step "p" repo onPushFailure');
    },
  );

  test.concurrent(
    "reports a bad shape without also reporting the pairing",
    () => {
      const issues = validate([
        stepSpecWithOverrides("both", {
          executionMode: "no_workspace",
          repo: { mode: "readWrite", message: "{{env.X}}" },
        }),
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain("tokens");
    },
  );
});
