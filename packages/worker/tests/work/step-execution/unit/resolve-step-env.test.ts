import { describe, expect, test } from "bun:test";
import type { EnvVarSpec } from "@boboddy/sdk/env-vars";
import {
  MissingStepEnvError,
  resolveStepEnv,
} from "../../../../src/work/step-execution/application/resolve-step-env";

const inherit = (
  name: string,
  overrides: Partial<Extract<EnvVarSpec, { source: "inherit" }>> = {},
): EnvVarSpec => ({
  name,
  source: "inherit",
  from: name,
  secret: false,
  optional: false,
  ...overrides,
});

const value = (name: string, template: string, secret = false): EnvVarSpec => ({
  name,
  source: "value",
  value: template,
  secret,
});

describe("resolveStepEnv", () => {
  test.concurrent("returns empty results when no env is declared", () => {
    for (const envJson of [null, undefined, []]) {
      expect(resolveStepEnv({ envJson, inputJson: {}, workerEnv: {} })).toEqual(
        {
          stepEnv: {},
          promptEnv: {},
          secretValues: [],
        },
      );
    }
  });

  test.concurrent("renders value entries against the run input", () => {
    const result = resolveStepEnv({
      envJson: [
        value("WAREHOUSE_URL", "https://warehouse.internal"),
        value("ACCOUNT_ID", "{{input.accountId}}"),
        value("TENANT_URL", "https://{{input.tenant}}.example.com"),
      ],
      inputJson: { accountId: "acct-1", tenant: "acme" },
      workerEnv: {},
    });

    expect(result.stepEnv).toEqual({
      WAREHOUSE_URL: "https://warehouse.internal",
      ACCOUNT_ID: "acct-1",
      TENANT_URL: "https://acme.example.com",
    });
    expect(result.promptEnv).toEqual(result.stepEnv);
  });

  test.concurrent("renders a missing input token as an empty string", () => {
    const result = resolveStepEnv({
      envJson: [value("ACCOUNT_ID", "{{input.accountId}}")],
      inputJson: {},
      workerEnv: {},
    });

    expect(result.stepEnv).toEqual({ ACCOUNT_ID: "" });
  });

  test.concurrent("inherits from the worker env by name", () => {
    const result = resolveStepEnv({
      envJson: [inherit("SENTRY_DSN")],
      inputJson: {},
      workerEnv: { SENTRY_DSN: "https://sentry.example.com/1" },
    });

    expect(result.stepEnv).toEqual({
      SENTRY_DSN: "https://sentry.example.com/1",
    });
  });

  test.concurrent("inherits from a renamed source variable", () => {
    const result = resolveStepEnv({
      envJson: [
        inherit("DB_PASSWORD", { from: "STAGING_DB_PASSWORD", secret: true }),
      ],
      inputJson: {},
      workerEnv: { STAGING_DB_PASSWORD: "hunter22", DB_PASSWORD: "wrong" },
    });

    expect(result.stepEnv).toEqual({ DB_PASSWORD: "hunter22" });
  });

  test.concurrent("a step value is never overridden by the worker env", () => {
    const result = resolveStepEnv({
      envJson: [value("LOG_LEVEL", "debug")],
      inputJson: {},
      workerEnv: { LOG_LEVEL: "error" },
    });

    expect(result.stepEnv).toEqual({ LOG_LEVEL: "debug" });
  });

  test.concurrent("prefers the worker value over the default", () => {
    const entry = inherit("LOG_LEVEL", { optional: true, default: "info" });

    expect(
      resolveStepEnv({
        envJson: [entry],
        inputJson: {},
        workerEnv: { LOG_LEVEL: "warn" },
      }).stepEnv,
    ).toEqual({ LOG_LEVEL: "warn" });
    expect(
      resolveStepEnv({ envJson: [entry], inputJson: {}, workerEnv: {} })
        .stepEnv,
    ).toEqual({ LOG_LEVEL: "info" });
  });

  test.concurrent("an empty worker value counts as set", () => {
    const result = resolveStepEnv({
      envJson: [inherit("LOG_LEVEL", { default: "info" })],
      inputJson: {},
      workerEnv: { LOG_LEVEL: "" },
    });

    expect(result.stepEnv).toEqual({ LOG_LEVEL: "" });
  });

  test.concurrent("omits a missing optional entry without a default", () => {
    const result = resolveStepEnv({
      envJson: [inherit("SENTRY_DSN", { optional: true })],
      inputJson: {},
      workerEnv: {},
    });

    expect(result).toEqual({ stepEnv: {}, promptEnv: {}, secretValues: [] });
  });

  test.concurrent(
    "throws one error naming every missing variable and no values",
    () => {
      const run = () =>
        resolveStepEnv({
          envJson: [
            inherit("WAREHOUSE_TOKEN", { secret: true }),
            inherit("DB_PASSWORD", { from: "STAGING_DB_PASSWORD" }),
            inherit("PRESENT"),
            inherit("OPTIONAL_ONE", { optional: true }),
          ],
          inputJson: {},
          workerEnv: { PRESENT: "super-secret-present-value" },
        });

      expect(run).toThrow(MissingStepEnvError);
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(MissingStepEnvError);
        const message = (error as Error).message;
        expect(message).toContain("WAREHOUSE_TOKEN");
        expect(message).toContain("STAGING_DB_PASSWORD");
        expect(message).toContain("DB_PASSWORD");
        expect(message).not.toContain("OPTIONAL_ONE");
        expect(message).not.toContain("super-secret-present-value");
        expect((error as MissingStepEnvError).missing).toEqual([
          "WAREHOUSE_TOKEN",
          "STAGING_DB_PASSWORD (for DB_PASSWORD)",
        ]);
      }
    },
  );

  test.concurrent("excludes secret entries from promptEnv", () => {
    const result = resolveStepEnv({
      envJson: [
        value("PUBLIC_URL", "https://{{input.tenant}}.example.com"),
        value("TENANT_API_KEY", "{{input.tenant}}-key", true),
        inherit("WAREHOUSE_TOKEN", { secret: true }),
        inherit("LOG_LEVEL", { default: "info" }),
      ],
      inputJson: { tenant: "acme" },
      workerEnv: { WAREHOUSE_TOKEN: "wh-token-value" },
    });

    expect(result.stepEnv).toEqual({
      PUBLIC_URL: "https://acme.example.com",
      TENANT_API_KEY: "acme-key",
      WAREHOUSE_TOKEN: "wh-token-value",
      LOG_LEVEL: "info",
    });
    expect(result.promptEnv).toEqual({
      PUBLIC_URL: "https://acme.example.com",
      LOG_LEVEL: "info",
    });
    expect(result.secretValues).toEqual(["acme-key", "wh-token-value"]);
  });

  test.concurrent("does not register empty secret values for masking", () => {
    const result = resolveStepEnv({
      envJson: [value("TENANT_API_KEY", "{{input.key}}", true)],
      inputJson: {},
      workerEnv: {},
    });

    expect(result.stepEnv).toEqual({ TENANT_API_KEY: "" });
    expect(result.secretValues).toEqual([]);
  });

  test.concurrent("refuses to inherit a BOBODDY_* worker variable", () => {
    const run = () =>
      resolveStepEnv({
        envJson: [
          inherit("STOLEN", { from: "BOBODDY_API_TOKEN", secret: true }),
        ],
        inputJson: {},
        workerEnv: { BOBODDY_API_TOKEN: "worker-credential" },
      });

    expect(run).toThrow(/BOBODDY_API_TOKEN/);
    expect(run).not.toThrow(/worker-credential/);
  });
});
