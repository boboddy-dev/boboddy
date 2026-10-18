import { describe, expect, test } from "bun:test";
import type { EnvVarSpec } from "@boboddy/sdk/env-vars";
import {
  MissingStepEnvError,
  planStepEnv,
  resolveStepEnv,
  withInferredMcpEnv,
} from "../../../../src/work/task/application/resolve-step-env";

const inherit = (
  name: string,
  overrides: Partial<Extract<EnvVarSpec, { source: "inherit" }>> = {},
): EnvVarSpec => ({
  name,
  source: "inherit",
  from: name,
  secret: false,
  optional: false,
  applies: "agent",
  ...overrides,
});

const value = (name: string, template: string): EnvVarSpec => ({
  name,
  source: "value",
  value: template,
  secret: false,
  applies: "agent",
});

const mcpVar = (name: string, mcp: string, optional = false) =>
  inherit(name, { secret: true, optional, mcp });

function missingError(run: () => unknown): MissingStepEnvError {
  try {
    run();
  } catch (error) {
    if (error instanceof MissingStepEnvError) return error;
    throw error;
  }
  throw new Error("expected a MissingStepEnvError");
}

describe("resolveStepEnv: MCP variables", () => {
  test.concurrent(
    "a missing tagged variable fails the step, naming the MCP",
    () => {
      const error = missingError(() =>
        resolveStepEnv({
          envJson: [mcpVar("DATADOG_API_KEY", "datadog")],
          inputJson: {},
          workerEnv: {},
        }),
      );
      expect(error.missing).toEqual(['DATADOG_API_KEY (for MCP "datadog")']);
      expect(error.message).toContain('DATADOG_API_KEY (for MCP "datadog")');
    },
  );

  test.concurrent(
    "a renamed MCP variable names both the variable and the MCP",
    () => {
      const error = missingError(() =>
        resolveStepEnv({
          envJson: [
            inherit("DD_KEY", { from: "DATADOG_API_KEY", mcp: "datadog" }),
          ],
          inputJson: {},
          workerEnv: {},
        }),
      );
      expect(error.missing).toEqual([
        'DATADOG_API_KEY (for DD_KEY, MCP "datadog")',
      ]);
    },
  );

  test.concurrent(
    "an optionalEnv MCP variable that is not set is omitted without error",
    () => {
      const result = resolveStepEnv({
        envJson: [
          mcpVar("DATADOG_API_KEY", "datadog"),
          mcpVar("DATADOG_SITE", "datadog", true),
        ],
        inputJson: {},
        workerEnv: { DATADOG_API_KEY: "dd-api-key-value" },
      });
      expect(result.stepEnv).toEqual({ DATADOG_API_KEY: "dd-api-key-value" });
      expect(result.promptEnv).toEqual({});
      expect(result.secretValues).toEqual(["dd-api-key-value"]);
    },
  );

  test.concurrent(
    "untagged and tagged missing variables are reported together",
    () => {
      const error = missingError(() =>
        resolveStepEnv({
          envJson: [
            inherit("PLAIN"),
            mcpVar("SENTRY_TOKEN", "sentry"),
            mcpVar("DATADOG_API_KEY", "datadog"),
          ],
          inputJson: {},
          workerEnv: {},
        }),
      );
      expect(error.missing).toEqual([
        "PLAIN",
        'SENTRY_TOKEN (for MCP "sentry")',
        'DATADOG_API_KEY (for MCP "datadog")',
      ]);
    },
  );
});

describe("withInferredMcpEnv (D3)", () => {
  test.concurrent(
    "adds a required secret inherit entry tagged with the ref for each undeclared variable",
    () => {
      expect(
        withInferredMcpEnv(
          [inherit("TICKET")],
          [
            {
              key: "datadog",
              requiredEnv: ["DATADOG_API_KEY", "DATADOG_SITE"],
            },
          ],
        ),
      ).toEqual([
        inherit("TICKET"),
        mcpVar("DATADOG_API_KEY", "datadog"),
        mcpVar("DATADOG_SITE", "datadog"),
      ]);
    },
  );

  test.concurrent("a variable the step declares itself wins (D4)", () => {
    const declared = value("DATADOG_SITE", "{{input.site}}");
    expect(
      withInferredMcpEnv(
        [declared],
        [
          {
            key: "datadog",
            requiredEnv: ["DATADOG_SITE"],
          },
        ],
      ),
    ).toEqual([declared]);
  });

  test.concurrent(
    "a setup-only declaration does not reach the agent, so the MCP still infers its variable",
    () => {
      const declared = inherit("DATADOG_SITE", { applies: "setup" });
      expect(
        withInferredMcpEnv(
          [declared],
          [{ key: "datadog", requiredEnv: ["DATADOG_SITE"] }],
        ),
      ).toEqual([declared, mcpVar("DATADOG_SITE", "datadog")]);
    },
  );

  test.concurrent("a variable shared by refs is tagged with the first", () => {
    expect(
      withInferredMcpEnv(null, [
        { key: "a", requiredEnv: ["SHARED"] },
        { key: "b", requiredEnv: ["SHARED"] },
      ]),
    ).toEqual([mcpVar("SHARED", "a")]);
  });
});

describe("planStepEnv", () => {
  const datadogRef = {
    key: "datadog",
    requiredEnv: ["DATADOG_API_KEY"],
  };

  test.concurrent(
    "a step with only inline servers gets no MCP env resolver",
    () => {
      const plan = planStepEnv({
        envJson: [inherit("PLAIN")],
        inputJson: {},
        workerEnv: { PLAIN: "x" },
        opencodeMcpJson: { inline: { type: "local", command: ["x"] } },
      });
      expect(plan.resolveMcpEnv).toBeUndefined();
      expect(plan.resolved.stepEnv).toEqual({ PLAIN: "x" });
    },
  );

  test.concurrent(
    "an inline server missing a tagged variable fails the step",
    () => {
      const error = missingError(() =>
        planStepEnv({
          envJson: [mcpVar("LINEAR_API_KEY", "linear")],
          inputJson: {},
          workerEnv: {},
          opencodeMcpJson: { linear: { type: "remote", url: "https://x" } },
        }),
      );
      expect(error.missing).toEqual(['LINEAR_API_KEY (for MCP "linear")']);
    },
  );

  test.concurrent(
    "a ref fails the step on a missing inferred variable",
    () => {
      const plan = planStepEnv({
        envJson: null,
        inputJson: {},
        workerEnv: {},
        opencodeMcpJson: { datadog: { type: "ref" } },
      });
      const error = missingError(() =>
        plan.resolveMcpEnv?.([datadogRef]),
      );
      expect(error.missing).toEqual(['DATADOG_API_KEY (for MCP "datadog")']);
    },
  );

  test.concurrent("injects and masks an inferred variable that is set", () => {
    const plan = planStepEnv({
      envJson: null,
      inputJson: {},
      workerEnv: { DATADOG_API_KEY: "dd-api-key-value" },
      opencodeMcpJson: { datadog: { type: "ref" } },
    });
    expect(plan.resolveMcpEnv?.([datadogRef])).toEqual({
      stepEnv: { DATADOG_API_KEY: "dd-api-key-value" },
      setupEnv: {},
      promptEnv: {},
      secretValues: ["dd-api-key-value"],
    });
  });
});
