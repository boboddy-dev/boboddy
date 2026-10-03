import { describe, expect, test } from "bun:test";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpecWithOverrides } from "./definition-spec-fixtures";

/**
 * `validateDefinitionSpecs — env vars`: the `env-var` check runs the
 * `envVarsSchema` wire schema over hand-built specs that bypass the `Env`
 * authoring helpers.
 */
describe("validateDefinitionSpecs — env vars", () => {
  const validate = (steps: ReturnType<typeof stepSpecWithOverrides>[]) =>
    validateDefinitionSpecs({ pipelines: [], steps });

  test.concurrent("accepts a step declaring valid env vars", () => {
    expect(
      validate([
        stepSpecWithOverrides("env-step", {
          envJson: [
            {
              name: "ACCOUNT_ID",
              source: "value",
              value: "{{input.accountId}}",
              secret: false,
            },
            {
              name: "WAREHOUSE_TOKEN",
              source: "inherit",
              from: "WAREHOUSE_TOKEN",
              secret: true,
              optional: false,
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("stays quiet for null and omitted envJson", () => {
    expect(
      validate([
        stepSpecWithOverrides("null-env", { envJson: null }),
        stepSpecWithOverrides("no-env"),
      ]),
    ).toEqual([]);
  });

  test.concurrent("rejects a reserved name, naming the step and entry", () => {
    const issues = validate([
      stepSpecWithOverrides("env-step", {
        envJson: [
          {
            name: "ACCOUNT_ID",
            source: "value",
            value: "x",
            secret: false,
          },
          { name: "HOME", source: "value", value: "/tmp", secret: false },
        ],
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("env-var");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain(
      'Step "env-step" env var #2 ("HOME") name',
    );
    expect(issues[0]?.message).toContain("reserved");
  });

  test.concurrent("rejects a static secret value", () => {
    const issues = validate([
      stepSpecWithOverrides("env-step", {
        envJson: [
          { name: "API_KEY", source: "value", value: "hunter2", secret: true },
        ],
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("env-var");
    expect(issues[0]?.message).toContain("static secret");
    expect(issues[0]?.message).not.toContain("hunter2");
  });

  test.concurrent("rejects a secret inherit carrying a default", () => {
    const issues = validate([
      stepSpecWithOverrides("env-step", {
        envJson: [
          {
            name: "DB_PASSWORD",
            source: "inherit",
            from: "DB_PASSWORD",
            secret: true,
            optional: true,
            default: "fallback",
          },
        ],
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("secret cannot carry a default");
  });

  test.concurrent("rejects duplicate names at the list level", () => {
    const entry = {
      name: "A",
      source: "value",
      value: "x",
      secret: false,
    } as const;
    const issues = validate([
      stepSpecWithOverrides("env-step", { envJson: [entry, entry] }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('Step "env-step" env:');
    expect(issues[0]?.message).toContain("unique");
  });
});
