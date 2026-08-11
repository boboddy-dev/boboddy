import { describe, expect, test } from "bun:test";
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
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    opencodePluginJson: null,
    healthChecksJson: null,
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

  test("emits executionMode: \"no_workspace\" when set", () => {
    const content = generateStepsFileContent([
      makeStep({ executionMode: "no_workspace" }),
    ]);

    expect(content).toContain('executionMode: "no_workspace"');
  });

  test("omits executionMode when it is the default \"workspace\"", () => {
    const content = generateStepsFileContent([
      makeStep({ executionMode: "workspace" }),
    ]);

    expect(content).not.toContain("executionMode:");
  });
});
