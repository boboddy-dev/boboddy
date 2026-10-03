/**
 * Backward-compatibility guard for persisted `envJson`.
 *
 * `V1_ROWS` are frozen copies of `step_definitions.env_json` values exactly as
 * v1 wrote them. Never edit or regenerate them to make this test pass: if a
 * schema change breaks one, the change breaks already-stored rows. Make it
 * additive, or ship a SQL migration over `env_json` and add a `V2_ROWS`
 * alongside these.
 */
import { describe, expect, test } from "bun:test";
import { storedEnvVarsSchema, type EnvVarSpec } from "../src/env-vars";

const V1_ROWS: readonly {
  label: string;
  json: string;
  expected: EnvVarSpec[];
}[] = [
  {
    label: "literal value",
    json: '[{"name":"WAREHOUSE_URL","source":"value","value":"https://warehouse.internal","secret":false}]',
    expected: [
      {
        name: "WAREHOUSE_URL",
        source: "value",
        value: "https://warehouse.internal",
        secret: false,
      },
    ],
  },
  {
    label: "input-templated secret value",
    json: '[{"name":"TENANT_API_KEY","source":"value","value":"{{input.tenant}}-key","secret":true}]',
    expected: [
      {
        name: "TENANT_API_KEY",
        source: "value",
        value: "{{input.tenant}}-key",
        secret: true,
      },
    ],
  },
  {
    label: "required inherit",
    json: '[{"name":"SENTRY_DSN","source":"inherit","from":"SENTRY_DSN","secret":false,"optional":false}]',
    expected: [
      {
        name: "SENTRY_DSN",
        source: "inherit",
        from: "SENTRY_DSN",
        secret: false,
        optional: false,
      },
    ],
  },
  {
    label: "renamed secret inherit",
    json: '[{"name":"DB_PASSWORD","source":"inherit","from":"STAGING_DB_PASSWORD","secret":true,"optional":false}]',
    expected: [
      {
        name: "DB_PASSWORD",
        source: "inherit",
        from: "STAGING_DB_PASSWORD",
        secret: true,
        optional: false,
      },
    ],
  },
  {
    label: "optional inherit with default",
    json: '[{"name":"LOG_LEVEL","source":"inherit","from":"LOG_LEVEL","secret":false,"optional":true,"default":"info"}]',
    expected: [
      {
        name: "LOG_LEVEL",
        source: "inherit",
        from: "LOG_LEVEL",
        secret: false,
        optional: true,
        default: "info",
      },
    ],
  },
  {
    label: "empty list",
    json: "[]",
    expected: [],
  },
];

describe("storedEnvVarsSchema v1 compatibility", () => {
  for (const row of V1_ROWS) {
    test.concurrent(`reads v1 row: ${row.label}`, () => {
      const result = storedEnvVarsSchema.safeParse(JSON.parse(row.json));

      expect(result.success).toBe(true);
      expect(result.data).toEqual(row.expected);
    });
  }

  test.concurrent("reads all v1 shapes together in one list", () => {
    const merged = V1_ROWS.flatMap((row) => row.expected);

    expect(storedEnvVarsSchema.safeParse(merged).success).toBe(true);
  });

  test.concurrent("ignores keys added by a newer writer", () => {
    const result = storedEnvVarsSchema.safeParse([
      {
        name: "LOG_LEVEL",
        source: "inherit",
        from: "LOG_LEVEL",
        secret: false,
        optional: true,
        addedLater: "x",
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      {
        name: "LOG_LEVEL",
        source: "inherit",
        from: "LOG_LEVEL",
        secret: false,
        optional: true,
      },
    ]);
  });

  test.concurrent(
    "does not re-apply write-time rules, so stricter rules never orphan old rows",
    () => {
      const result = storedEnvVarsSchema.safeParse([
        {
          name: "HOME",
          source: "value",
          value: "x",
          secret: false,
        },
      ]);

      expect(result.success).toBe(true);
    },
  );
});
