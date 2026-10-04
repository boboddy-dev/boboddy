import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveRepoConfig } from "@boboddy/sdk/repo-config";
import { codeStep, Runtime } from "@boboddy/sdk/definitions/steps";
import {
  generateStepsFileContent,
  keyToVarName,
  type StepDefContract,
} from "../../../../src/steps/step-definitions/infra/step-file-generator";

function makeStep(overrides: Partial<StepDefContract> = {}): StepDefContract {
  return {
    key: "lookup-criteria",
    name: "Lookup Criteria",
    description: null,
    prompt: "Open the app.",
    version: 1,
    status: "active",
    kind: "user_defined",
    executionMode: "workspace",
    devcontainerConfigPath: null,
    repo: resolveRepoConfig("workspace"),
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

describe("generateStepsFileContent code step runtime", () => {
  test("omits runtime and the Runtime import for the default managed runtime", () => {
    const content = generateStepsFileContent([
      makeStep({ kind: "code", managedRuntime: "bun1", prompt: null }),
    ]);

    expect(content).not.toContain("environment:");
    expect(content).not.toContain("Runtime");
  });

  test("emits Runtime.managed.<id>() and imports Runtime for another managed runtime", () => {
    const content = generateStepsFileContent([
      makeStep({ kind: "code", managedRuntime: "node24", prompt: null }),
    ]);

    expect(content).toContain(
      "environment: {\n    runtime: Runtime.managed.node24(),\n  }",
    );
    expect(content).toContain(
      'import { defineStep, Runtime } from "@boboddy/sdk/definitions/steps";',
    );
  });

  test("emits an explicit Runtime.devcontainer() for a non-managed code step without a config path", () => {
    const content = generateStepsFileContent([
      makeStep({ kind: "code", managedRuntime: null, prompt: null }),
      makeStep({ key: "legacy", kind: "code", prompt: null }),
    ]);

    expect(content.match(/runtime: Runtime\.devcontainer\(\),/g)).toHaveLength(
      2,
    );
    expect(content).toContain(
      'import { defineStep, Runtime } from "@boboddy/sdk/definitions/steps";',
    );
  });

  test("keeps the config emission for a non-managed code step with a config path", () => {
    const content = generateStepsFileContent([
      makeStep({
        kind: "code",
        managedRuntime: null,
        devcontainerConfigPath: ".devcontainer/alt/devcontainer.json",
        prompt: null,
      }),
    ]);

    expect(content).toContain(
      'runtime: Runtime.devcontainer({ config: ".devcontainer/alt/devcontainer.json" }),',
    );
    expect(content).not.toContain("Runtime.devcontainer(),");
  });

  test("leaves agent steps unchanged whatever kind or managedRuntime they carry", () => {
    const content = generateStepsFileContent([
      makeStep({ key: "plain-agent", kind: "user_defined" }),
      makeStep({
        key: "null-agent",
        kind: "user_defined",
        managedRuntime: null,
      }),
      makeStep({ key: "legacy-agent", kind: undefined }),
    ]);

    expect(content).not.toContain("environment:");
    expect(content).not.toContain("Runtime");
  });

  test("pushing, pulling and pushing again keeps managedRuntime and devcontainerConfigPath", async () => {
    const noop = () => ({});
    const authored = [
      {
        key: "omitted",
        spec: codeStep({ key: "omitted", name: "Omitted", fn: noop }),
      },
      {
        key: "default-explicit",
        spec: codeStep({
          key: "default-explicit",
          name: "Default Explicit",
          environment: { runtime: Runtime.managed.bun1() },
          fn: noop,
        }),
      },
      {
        key: "node",
        spec: codeStep({
          key: "node",
          name: "Node",
          environment: { runtime: Runtime.managed.node24() },
          fn: noop,
        }),
      },
      {
        key: "project",
        spec: codeStep({
          key: "project",
          name: "Project",
          environment: { runtime: Runtime.devcontainer() },
          fn: noop,
        }),
      },
      {
        key: "project-config",
        spec: codeStep({
          key: "project-config",
          name: "Project Config",
          environment: {
            runtime: Runtime.devcontainer({
              config: ".devcontainer/alt/devcontainer.json",
            }),
          },
          fn: noop,
        }),
      },
      {
        key: "legacy",
        spec: {
          ...codeStep({ key: "legacy", name: "Legacy", fn: noop }),
          managedRuntime: null,
        },
      },
    ];

    const pulled = generateStepsFileContent(
      authored.map(({ key, spec }) =>
        makeStep({
          key,
          kind: "code",
          prompt: null,
          devcontainerConfigPath: spec.devcontainerConfigPath ?? null,
          managedRuntime: spec.managedRuntime ?? null,
        }),
      ),
    ).replace(
      'from "@boboddy/sdk/definitions/steps"',
      'from "./code-step-shim"',
    );

    const shim = [
      'import { codeStep } from "@boboddy/sdk/definitions/steps";',
      'export * from "@boboddy/sdk/definitions/steps";',
      "export const defineStep = ({ key, name, environment }) =>",
      "  codeStep({ key, name, environment, fn: () => ({}) });",
      "",
    ].join("\n");

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      await writeFile(path.join(dir, "code-step-shim.ts"), shim, "utf-8");
      const file = path.join(dir, "steps.ts");
      await writeFile(file, pulled, "utf-8");
      const loaded = (await import(file)) as Record<
        string,
        {
          managedRuntime?: string | null;
          devcontainerConfigPath?: string | null;
        }
      >;

      for (const { key, spec } of authored) {
        const repushed = loaded[keyToVarName(key)];
        expect({
          key,
          managedRuntime: repushed?.managedRuntime ?? null,
          devcontainerConfigPath: repushed?.devcontainerConfigPath ?? null,
        }).toEqual({
          key,
          managedRuntime: spec.managedRuntime ?? null,
          devcontainerConfigPath: spec.devcontainerConfigPath ?? null,
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
