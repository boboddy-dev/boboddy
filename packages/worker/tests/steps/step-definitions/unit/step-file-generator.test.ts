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
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    opencodePluginJson: null,
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
});
