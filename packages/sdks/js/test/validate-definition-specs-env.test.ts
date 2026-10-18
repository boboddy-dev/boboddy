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

  test.concurrent("accepts an env var owned by a declared ref server", () => {
    expect(
      validate([
        stepSpecWithOverrides("env-step", {
          opencodeMcpJson: { datadog: { type: "ref" } },
          envJson: [
            {
              name: "DATADOG_API_KEY",
              source: "inherit",
              from: "DATADOG_API_KEY",
              secret: true,
              optional: false,
              mcp: "datadog",
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("accepts an env var owned by an inline server", () => {
    expect(
      validate([
        stepSpecWithOverrides("env-step", {
          opencodeMcpJson: {
            playwright: { type: "local", command: ["npx", "x"] },
            linear: { type: "remote", url: "https://x" },
          },
          envJson: [
            {
              name: "PW_TOKEN",
              source: "inherit",
              from: "PW_TOKEN",
              secret: true,
              optional: false,
              mcp: "playwright",
            },
            {
              name: "LINEAR_API_KEY",
              source: "inherit",
              from: "LINEAR_API_KEY",
              secret: true,
              optional: false,
              mcp: "linear",
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("rejects an env var owned by an undeclared server", () => {
    const issues = validate([
      stepSpecWithOverrides("env-step", {
        opencodeMcpJson: {
          postgres: { type: "ref" },
          playwright: { type: "local", command: ["npx", "x"] },
        },
        envJson: [
          {
            name: "A",
            source: "inherit",
            from: "A",
            secret: true,
            optional: false,
            mcp: "datadog",
          },
        ],
      }),
    ]);
    expect(issues.map((issue) => issue.check)).toEqual(["env-var-mcp"]);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain(
      'Step "env-step" env var #1 ("A") belongs to MCP server "datadog"',
    );
    expect(issues[0]?.message).toContain(
      "Declared servers: playwright, postgres.",
    );
  });

  test.concurrent(
    "rejects an mcp-owned env var on a step with no servers",
    () => {
      const issues = validate([
        stepSpecWithOverrides("env-step", {
          envJson: [
            {
              name: "TOKEN",
              source: "inherit",
              from: "TOKEN",
              secret: true,
              optional: false,
              mcp: "tch",
            },
          ],
        }),
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain("Declared servers: (none).");
    },
  );

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

  test.concurrent("accepts setup and both vars on a workspace step", () => {
    expect(
      validate([
        stepSpecWithOverrides("env-step", {
          envJson: [
            {
              name: "NPM_TOKEN",
              source: "inherit",
              from: "NPM_TOKEN",
              secret: true,
              optional: false,
              applies: "setup",
            },
            {
              name: "REGISTRY",
              source: "value",
              value: "r",
              secret: false,
              applies: "both",
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test.concurrent("rejects a setup var on a no_workspace step", () => {
    const issues = validate([
      stepSpecWithOverrides("host-step", {
        executionMode: "no_workspace",
        envJson: [
          {
            name: "NPM_TOKEN",
            source: "value",
            value: "x",
            secret: false,
            applies: "setup",
          },
        ],
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("env-var-applies");
    expect(issues[0]?.message).toContain("no_workspace");
  });

  test.concurrent("rejects a setup var on an MCP-owned entry", () => {
    const issues = validate([
      stepSpecWithOverrides("mcp-step", {
        opencodeMcpJson: { datadog: { type: "ref" } },
        envJson: [
          {
            name: "DATADOG_API_KEY",
            source: "inherit",
            from: "DATADOG_API_KEY",
            secret: true,
            optional: false,
            mcp: "datadog",
            applies: "both",
          },
        ],
      }),
    ]);
    expect(issues.map((issue) => issue.check)).toEqual(["env-var-applies"]);
    expect(issues[0]?.message).toContain("MCP server");
  });
});
