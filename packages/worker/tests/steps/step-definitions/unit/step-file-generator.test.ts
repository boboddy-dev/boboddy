import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { EnvVarSpec } from "@boboddy/sdk/env-vars";
import { resolveRepoConfig } from "@boboddy/sdk/repo-config";
import {
  generateStepsFileContent,
  type StepDefContract,
} from "../../../../src/steps/step-definitions/infra/step-file-generator";

function makeStep(overrides: Partial<StepDefContract> = {}): StepDefContract {
  return {
    key: "browser-repro",
    name: "Browser Repro",
    description: null,
    prompt: "Open the app.",
    version: 1,
    status: "active",
    executionMode: "workspace",
    devcontainerConfigPath: null,
    repo: resolveRepoConfig(overrides.executionMode ?? "workspace"),
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    opencodePluginJson: null,
    healthChecksJson: null,
    envJson: null,
    signalExtractorDefinitions: [],
    ...overrides,
  };
}

describe("generateStepsFileContent", () => {
  test("keeps plain prompts as string literals", () => {
    const content = generateStepsFileContent([makeStep()]);

    expect(content).toContain('agentPrompt: "Open the app."');
  });

  test("renders scoped prompt variables as function-style agentPrompt", () => {
    const content = generateStepsFileContent([
      makeStep({
        prompt: [
          "Open {{env.BASE_URL}}.",
          "Investigate {{input.title}}.",
          "Save files to {{boboddy.artifactsDir}}trace.zip.",
        ].join("\n"),
      }),
    ]);

    expect(content).toContain("agentPrompt: ({ input, env, boboddy }) => `");
    expect(content).toContain("Open ${env.BASE_URL}.");
    expect(content).toContain("Investigate ${input.title}.");
    expect(content).toContain(
      "Save files to ${boboddy.artifactsDir}trace.zip.",
    );
  });

  test("preserves unscoped prompt tokens alongside scoped variables", () => {
    const content = generateStepsFileContent([
      makeStep({
        prompt: "Legacy {{title}} with new {{input.title}}",
      }),
    ]);

    expect(content).toContain(
      "agentPrompt: ({ input }) => `Legacy {{title}} with new ${input.title}`",
    );
  });

  test("emits mcpServers when present and non-empty", () => {
    const content = generateStepsFileContent([
      makeStep({
        opencodeMcpJson: {
          browser: { type: "local", command: ["npx", "-y", "pkg"] },
        },
      }),
    ]);

    expect(content).toContain("mcpServers: {");
    expect(content).toContain('"browser"');
  });

  test("omits mcpServers when null or empty", () => {
    const nullContent = generateStepsFileContent([
      makeStep({ opencodeMcpJson: null }),
    ]);
    const emptyContent = generateStepsFileContent([
      makeStep({ opencodeMcpJson: {} }),
    ]);

    expect(nullContent).not.toContain("mcpServers:");
    expect(emptyContent).not.toContain("mcpServers:");
  });

  test("emits plugins when present and non-empty", () => {
    const content = generateStepsFileContent([
      makeStep({ opencodePluginJson: [{ path: "./my-plugin.ts" }] }),
    ]);

    expect(content).toContain("plugins: [");
    expect(content).toContain("./my-plugin.ts");
  });

  test("omits plugins when null or empty", () => {
    const nullContent = generateStepsFileContent([
      makeStep({ opencodePluginJson: null }),
    ]);
    const emptyContent = generateStepsFileContent([
      makeStep({ opencodePluginJson: [] }),
    ]);

    expect(nullContent).not.toContain("plugins:");
    expect(emptyContent).not.toContain("plugins:");
  });

  test("emits healthChecks when present and non-empty, formatted like mcpServers/plugins", () => {
    const content = generateStepsFileContent([
      makeStep({
        healthChecksJson: [
          { tool: "browser_navigate", mcp: "browser", args: { url: "about:blank" } },
        ],
      }),
    ]);

    expect(content).toContain("healthChecks: [");
    expect(content).toContain('"browser_navigate"');
    expect(content).toContain('"browser"');
  });

  test("omits healthChecks when null or empty", () => {
    const nullContent = generateStepsFileContent([
      makeStep({ healthChecksJson: null }),
    ]);
    const emptyContent = generateStepsFileContent([
      makeStep({ healthChecksJson: [] }),
    ]);

    expect(nullContent).not.toContain("healthChecks:");
    expect(emptyContent).not.toContain("healthChecks:");
  });

  test("omits env and the Env import when envJson is null or empty", () => {
    for (const envJson of [null, []]) {
      const content = generateStepsFileContent([makeStep({ envJson })]);

      expect(content).not.toContain("environment:");
      expect(content).toContain(
        'import { defineStep } from "@boboddy/sdk/definitions/steps";',
      );
    }
  });

  test("emits plain values as bare strings and imports Env only when a helper is used", () => {
    const content = generateStepsFileContent([
      makeStep({
        envJson: [
          {
            name: "WAREHOUSE_URL",
            source: "value",
            value: "https://warehouse.internal",
            secret: false,
          },
        ],
      }),
    ]);

    expect(content).toContain(
      'vars: () => ({\n      WAREHOUSE_URL: "https://warehouse.internal",\n    })',
    );
    expect(content).not.toContain("Env.");
    expect(content).toContain(
      'import { defineStep } from "@boboddy/sdk/definitions/steps";',
    );
  });

  test("emits input templates as template literals and destructures input only then", () => {
    const content = generateStepsFileContent([
      makeStep({
        envJson: [
          {
            name: "ACCOUNT_ID",
            source: "value",
            value: "{{input.accountId}}",
            secret: false,
          },
          {
            name: "TENANT_URL",
            source: "value",
            value: "https://{{input.tenant}}.example.com",
            secret: false,
          },
        ],
      }),
    ]);

    expect(content).toContain("vars: ({ input }) => ({");
    expect(content).toContain("ACCOUNT_ID: `${input.accountId}`,");
    expect(content).toContain(
      "TENANT_URL: `https://${input.tenant}.example.com`,",
    );
  });

  test("leaves non-input tokens in an env template as literal text", () => {
    const content = generateStepsFileContent([
      makeStep({
        envJson: [
          {
            name: "NOTE",
            source: "value",
            value: "{{env.OTHER}} for {{input.id}}",
            secret: false,
          },
        ],
      }),
    ]);

    expect(content).toContain("NOTE: `{{env.OTHER}} for ${input.id}`,");
  });

  test("emits secret values and inherit entries through Env, spelling out only non-default options", () => {
    const content = generateStepsFileContent([
      makeStep({
        envJson: [
          {
            name: "TENANT_API_KEY",
            source: "value",
            value: "{{input.tenant}}-key",
            secret: true,
          },
          {
            name: "WAREHOUSE_TOKEN",
            source: "inherit",
            from: "WAREHOUSE_TOKEN",
            secret: true,
            optional: false,
          },
          {
            name: "DB_PASSWORD",
            source: "inherit",
            from: "STAGING_DB_PASSWORD",
            secret: true,
            optional: false,
          },
          {
            name: "LOG_LEVEL",
            source: "inherit",
            from: "LOG_LEVEL",
            secret: false,
            optional: true,
            default: "info",
          },
          {
            name: "SENTRY_DSN",
            source: "inherit",
            from: "SENTRY_DSN",
            secret: false,
            optional: false,
          },
        ],
      }),
    ]);

    expect(content).toContain(
      "TENANT_API_KEY: Env.value({ value: `${input.tenant}-key`, secret: true }),",
    );
    expect(content).toContain("WAREHOUSE_TOKEN: Env.inherit({ secret: true }),");
    expect(content).toContain(
      'DB_PASSWORD: Env.inherit({ from: "STAGING_DB_PASSWORD", secret: true }),',
    );
    expect(content).toContain(
      'LOG_LEVEL: Env.inherit({ optional: true, default: "info" }),',
    );
    expect(content).toContain("SENTRY_DSN: Env.inherit(),");
    expect(content).toContain(
      'import { defineStep, Env } from "@boboddy/sdk/definitions/steps";',
    );
  });

  test("emits unsafeAllowStatic for a static value on a secret-looking name", () => {
    const content = generateStepsFileContent([
      makeStep({
        envJson: [
          {
            name: "PUBLIC_API_KEY",
            source: "value",
            value: "pk_live_123",
            secret: false,
          },
          {
            name: "TOKEN_URL",
            source: "value",
            value: "{{input.tenant}}/token",
            secret: false,
          },
        ],
      }),
    ]);

    expect(content).toContain(
      'PUBLIC_API_KEY: Env.value({ value: "pk_live_123", unsafeAllowStatic: true }),',
    );
    expect(content).toContain("TOKEN_URL: `${input.tenant}/token`,");
  });

  test("declares environment before agentPrompt so its keys are inferred into the prompt", () => {
    const content = generateStepsFileContent([
      makeStep({
        prompt: "Query {{env.WAREHOUSE_URL}}.",
        envJson: [
          {
            name: "WAREHOUSE_URL",
            source: "value",
            value: "https://warehouse.internal",
            secret: false,
          },
        ],
      }),
    ]);

    expect(content.indexOf("environment: {")).toBeGreaterThan(-1);
    expect(content.indexOf("environment: {")).toBeLessThan(
      content.indexOf("agentPrompt:"),
    );
  });

  test("a generated steps file loads through defineStep and round-trips envJson", async () => {
    const envJson: EnvVarSpec[] = [
      {
        name: "WAREHOUSE_URL",
        source: "value",
        value: "https://warehouse.internal",
        secret: false,
      },
      {
        name: "ACCOUNT_ID",
        source: "value",
        value: "{{input.accountId}}",
        secret: false,
      },
      {
        name: "PUBLIC_API_KEY",
        source: "value",
        value: "pk_live_123",
        secret: false,
      },
      {
        name: "TENANT_API_KEY",
        source: "value",
        value: "{{input.tenant}}-key",
        secret: true,
      },
      {
        name: "WAREHOUSE_TOKEN",
        source: "inherit",
        from: "WAREHOUSE_TOKEN",
        secret: true,
        optional: false,
      },
      {
        name: "DB_PASSWORD",
        source: "inherit",
        from: "STAGING_DB_PASSWORD",
        secret: true,
        optional: false,
      },
      {
        name: "LOG_LEVEL",
        source: "inherit",
        from: "LOG_LEVEL",
        secret: false,
        optional: true,
        default: "info",
      },
      {
        name: "SENTRY_DSN",
        source: "inherit",
        from: "SENTRY_DSN",
        secret: false,
        optional: false,
      },
    ];
    const content = generateStepsFileContent([
      makeStep({
        key: "account-investigation",
        prompt: "Query {{env.WAREHOUSE_URL}} for {{input.accountId}}.",
        inputSchemaJson: {
          type: "object",
          properties: {
            accountId: { type: "string" },
            tenant: { type: "string" },
          },
          required: ["accountId", "tenant"],
        },
        envJson,
      }),
    ]);

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      const file = path.join(dir, "steps.ts");
      await writeFile(file, content, "utf-8");
      const loaded = (await import(file)) as {
        accountInvestigation: { envJson: EnvVarSpec[] | null };
      };

      expect(loaded.accountInvestigation.envJson).toEqual(envJson);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
