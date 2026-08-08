import { afterEach, describe, expect, test } from "bun:test";
import {
  resolveHealthCheckToolId,
  runHealthChecks,
} from "../../../../src/work/step-execution/application/run-health-checks";
import {
  healthCheck,
  installFakeAgent,
  restoreFetch,
  startedFakeAiServer,
} from "./helpers/fake-health-check-agent";

afterEach(() => {
  restoreFetch();
});

describe("resolveHealthCheckToolId", () => {
  test("qualifies with the mcp server key when set", () => {
    expect(
      resolveHealthCheckToolId(
        healthCheck({ mcp: "browser", tool: "browser_navigate" }),
      ),
    ).toBe("browser_browser_navigate");
  });

  test("uses the bare tool name when mcp is unset", () => {
    expect(resolveHealthCheckToolId(healthCheck({ tool: "greet" }))).toBe(
      "greet",
    );
  });
});

/**
 * A schema whose `$ref` targets `$defs`, but whose container keyword is the
 * legacy `definitions` instead — exactly the mismatch the #114 spike found on
 * a real plugin tool's generated schema (`boboddy-submit-step-findings`'s
 * recursive `findingsJson` argument). Ajv2020 throws at *compile* time on
 * this, before it ever gets to validate any actual arguments.
 */
const UNCOMPILABLE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { anything: { $ref: "#/$defs/missing" } },
  definitions: {
    missing: { type: "string" },
  },
};

describe("runHealthChecks — schema that fails to compile", () => {
  test("treats a schema Ajv cannot compile as unavailable, skipping validation rather than failing or crashing", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolIds: () => ["uses-uncompilable-schema"],
        toolList: () => [
          {
            id: "uses-uncompilable-schema",
            description: "has a schema Ajv can't compile",
            parameters: UNCOMPILABLE_SCHEMA,
          },
        ],
        toolStates: {
          "uses-uncompilable-schema": { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          // Whatever args are passed here are irrelevant: an uncompilable
          // schema is never checked against them, so this proves the call
          // still went through rather than being rejected as invalid-args.
          healthCheck({ tool: "uses-uncompilable-schema", args: { x: 1 } }),
        ],
        fakeAiServer,
      });

      expect(result).toEqual([
        {
          name: "uses-uncompilable-schema",
          resolvedId: "uses-uncompilable-schema",
          severity: "required",
          outcome: { kind: "passed" },
        },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });
});
