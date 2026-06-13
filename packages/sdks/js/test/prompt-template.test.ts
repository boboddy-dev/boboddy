import { describe, expect, test } from "bun:test";
import {
  createPromptTemplateContext,
  renderPromptTemplate,
} from "../src/definitions/steps/prompt-template";

describe("prompt-template", () => {
  test("creates scoped prompt tokens for function prompts", () => {
    const { input, env, boboddy } = createPromptTemplateContext<{
      title: string;
    }>();

    expect(`${input.title}`).toBe("{{input.title}}");
    expect(`${env.BASE_URL}`).toBe("{{env.BASE_URL}}");
    expect(`${boboddy.artifactsDir}`).toBe("{{boboddy.artifactsDir}}");
  });

  test("renders scoped and legacy-compatible prompt variables", () => {
    const rendered = renderPromptTemplate(
      [
        "Open {{env.BASE_URL}} for {{input.title}}.",
        "Legacy title: {{title}}.",
        "Artifacts: {{boboddy.artifactsDir}} and {{stepArtifactsDir}}.",
        "Missing: {{env.MISSING}}.",
      ].join("\n"),
      {
        title: "Checkout bug",
        input: { title: "Checkout bug" },
        env: { BASE_URL: "https://app.example.com" },
        boboddy: { artifactsDir: "/workspace/.boboddy/step-artifacts/" },
        stepArtifactsDir: "/workspace/.boboddy/step-artifacts/",
      },
    );

    expect(rendered).toBe(
      [
        "Open https://app.example.com for Checkout bug.",
        "Legacy title: Checkout bug.",
        "Artifacts: /workspace/.boboddy/step-artifacts/ and /workspace/.boboddy/step-artifacts/.",
        "Missing: .",
      ].join("\n"),
    );
  });
});
