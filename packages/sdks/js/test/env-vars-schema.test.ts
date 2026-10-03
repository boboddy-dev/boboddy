import { describe, expect, test } from "bun:test";
import {
  MAX_ENV_VAR_VALUE_LENGTH,
  MAX_ENV_VARS,
  envVarsSchema,
  type EnvVarsInput,
} from "../src/env-vars";

const valueEntry = {
  name: "ACCOUNT_ID",
  source: "value",
  value: "{{input.accountId}}",
  secret: false,
} as const;

const inheritEntry = {
  name: "WAREHOUSE_TOKEN",
  source: "inherit",
  from: "WAREHOUSE_TOKEN",
  secret: true,
  optional: false,
} as const;

function parseOne(entry: object): ReturnType<typeof envVarsSchema.safeParse> {
  return envVarsSchema.safeParse([entry]);
}

describe("envVarsSchema", () => {
  test.concurrent("parses value and inherit entries unchanged", () => {
    const input: EnvVarsInput = [
      valueEntry,
      inheritEntry,
      {
        name: "LOG_LEVEL",
        source: "inherit",
        from: "LOG_LEVEL",
        secret: false,
        optional: true,
        default: "info",
      },
    ];
    expect(envVarsSchema.parse(input)).toEqual(input);
  });

  test.concurrent("accepts a secret value that contains an input token", () => {
    expect(
      parseOne({
        name: "TENANT_API_KEY",
        source: "value",
        value: "{{input.tenant}}-key",
        secret: true,
      }).success,
    ).toBe(true);
  });

  test.concurrent("rejects a secret value with no input token", () => {
    const result = parseOne({
      name: "TENANT_API_KEY",
      source: "value",
      value: "hunter2",
      secret: true,
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("input");
  });

  test.concurrent("rejects a secret inherit that carries a default", () => {
    expect(parseOne({ ...inheritEntry, default: "fallback" }).success).toBe(
      false,
    );
  });

  test.concurrent("accepts a non-secret inherit that carries a default", () => {
    expect(
      parseOne({ ...inheritEntry, secret: false, default: "fallback" }).success,
    ).toBe(true);
  });

  test.concurrent("rejects names that are not upper snake case", () => {
    for (const name of ["lower", "1LEADING", "HAS-DASH", "HAS SPACE", ""]) {
      expect(parseOne({ ...valueEntry, name }).success).toBe(false);
    }
  });

  test.concurrent("rejects reserved names", () => {
    for (const name of [
      "BOBODDY_API_TOKEN",
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "OPENCODE_CONFIG_CONTENT",
      "npm_config_cache",
    ]) {
      expect(parseOne({ ...valueEntry, name }).success).toBe(false);
    }
  });

  test.concurrent(
    "rejects an inherit that reads a BOBODDY_* worker variable",
    () => {
      for (const from of [
        "BOBODDY_API_TOKEN",
        "BOBODDY_",
        "boboddy_api_token",
      ]) {
        const result = parseOne({ ...inheritEntry, from });
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain("BOBODDY_");
      }
    },
  );

  test.concurrent(
    "accepts an inherit that renames a non-BOBODDY source",
    () => {
      expect(
        parseOne({ ...inheritEntry, name: "DB_PASSWORD", from: "STAGING_DB" })
          .success,
      ).toBe(true);
    },
  );

  test.concurrent("rejects duplicate names", () => {
    expect(envVarsSchema.safeParse([valueEntry, valueEntry]).success).toBe(
      false,
    );
  });

  test.concurrent("caps the number of entries", () => {
    const entries = Array.from({ length: MAX_ENV_VARS + 1 }, (_, index) => ({
      ...valueEntry,
      name: `VAR_${String(index)}`,
    }));
    expect(envVarsSchema.safeParse(entries).success).toBe(false);
    expect(envVarsSchema.safeParse(entries.slice(1)).success).toBe(true);
  });

  test.concurrent("caps value and default length", () => {
    const tooLong = "x".repeat(MAX_ENV_VAR_VALUE_LENGTH + 1);
    expect(parseOne({ ...valueEntry, value: tooLong }).success).toBe(false);
    expect(
      parseOne({ ...inheritEntry, secret: false, default: tooLong }).success,
    ).toBe(false);
    expect(
      parseOne({
        ...valueEntry,
        value: "x".repeat(MAX_ENV_VAR_VALUE_LENGTH),
      }).success,
    ).toBe(true);
  });

  test.concurrent("rejects an unknown source with a discriminant error", () => {
    const result = parseOne({ ...valueEntry, source: "vault" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("source");
  });

  test.concurrent("rejects unknown fields, including unsafeAllowStatic", () => {
    expect(parseOne({ ...valueEntry, unsafeAllowStatic: true }).success).toBe(
      false,
    );
  });

  test.concurrent("rejects a value entry missing its secret flag", () => {
    const withoutSecret = Object.fromEntries(
      Object.entries(valueEntry).filter(([key]) => key !== "secret"),
    );
    expect(parseOne(withoutSecret).success).toBe(false);
  });
});
