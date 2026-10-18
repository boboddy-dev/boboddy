import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  envVarsSchema,
  type EnvVarSpec,
  type EnvVarsInput,
} from "@boboddy/sdk/env-vars";
import { resolveRepoConfig } from "@boboddy/sdk/repo-config";
import {
  generateStepsFileContent,
  type StepDefContract,
} from "../../../../src/steps/step-definitions/infra/step-file-generator";

function makeStep(envJson: EnvVarSpec[]): StepDefContract {
  return {
    key: "setup-env",
    name: "Setup Env",
    description: null,
    prompt: "Install the private packages.",
    version: 1,
    status: "active",
    executionMode: "workspace",
    devcontainerConfigPath: null,
    repo: resolveRepoConfig("workspace"),
    inputSchemaJson: {
      type: "object",
      properties: { tenant: { type: "string" } },
      required: ["tenant"],
    },
    resultSchemaJson: null,
    opencodeMcpJson: null,
    healthChecksJson: null,
    envJson,
    signalExtractorDefinitions: [],
  };
}

const ENV_JSON: EnvVarSpec[] = [
  {
    name: "NPM_TOKEN",
    source: "inherit",
    from: "NPM_TOKEN",
    secret: true,
    optional: false,
    applies: "setup",
  },
  {
    name: "REGISTRY_URL",
    source: "value",
    value: "https://registry.internal",
    secret: false,
    applies: "both",
  },
  {
    name: "TENANT_SETUP_KEY",
    source: "value",
    value: "{{input.tenant}}-setup",
    secret: true,
    applies: "setup",
  },
  {
    name: "ACCOUNT_ID",
    source: "value",
    value: "acct",
    secret: false,
    applies: "agent",
  },
];

describe("generateStepsFileContent env applies", () => {
  test("emits applies only for setup and both entries", () => {
    const content = generateStepsFileContent([makeStep(ENV_JSON)]);

    expect(content).toContain(
      'NPM_TOKEN: Env.inherit({ secret: true, applies: "setup" }),',
    );
    expect(content).toContain(
      'REGISTRY_URL: Env.value({ value: "https://registry.internal", applies: "both" }),',
    );
    expect(content).toContain(
      'TENANT_SETUP_KEY: Env.value({ value: `${input.tenant}-setup`, secret: true, applies: "setup" }),',
    );
    expect(content).toContain('ACCOUNT_ID: "acct",');
  });

  test("a generated steps file round-trips non-default applies", async () => {
    const content = generateStepsFileContent([makeStep(ENV_JSON)]);

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      const file = path.join(dir, "steps.ts");
      await writeFile(file, content, "utf-8");
      const loaded = (await import(file)) as {
        setupEnv: { envJson: EnvVarsInput | null };
      };

      expect(envVarsSchema.parse(loaded.setupEnv.envJson)).toEqual(ENV_JSON);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
