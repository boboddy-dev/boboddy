import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineStep } from "../src/definitions/steps/define-step";

describe("defineStep — plugins", () => {
  test("opencodePluginJson defaults to null when not provided", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
    });
    expect(spec.opencodePluginJson).toBeNull();
  });

  test("maps plugins array to opencodePluginJson", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      plugins: ["opencode-wakatime", ["@my-org/plugin", { key: "val" }]],
    });
    expect(spec.opencodePluginJson).toEqual([
      "opencode-wakatime",
      ["@my-org/plugin", { key: "val" }],
    ]);
  });

  test("maps multiple string plugins to opencodePluginJson", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      plugins: ["opencode-wakatime", "opencode-helicone-session"],
    });

    expect(spec.opencodePluginJson).toEqual([
      "opencode-wakatime",
      "opencode-helicone-session",
    ]);
  });

  test("explicit null plugins stores null", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      plugins: null,
    });
    expect(spec.opencodePluginJson).toBeNull();
  });
});

describe("defineStep — healthChecks", () => {
  test("healthChecksJson defaults to null when not provided", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
    });
    expect(spec.healthChecksJson).toBeNull();
  });

  test("maps healthChecks to healthChecksJson", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      mcpServers: {
        playwright: {
          type: "local",
          command: ["npx", "-y", "@playwright/mcp"],
        },
      },
      healthChecks: [
        {
          mcp: "playwright",
          tool: "browser_navigate",
          args: { url: "about:blank" },
        },
        { tool: "my_plugin_tool", severity: "warn", timeoutMs: 5000 },
      ],
    });

    expect(spec.healthChecksJson).toEqual([
      {
        mcp: "playwright",
        tool: "browser_navigate",
        args: { url: "about:blank" },
      },
      { tool: "my_plugin_tool", severity: "warn", timeoutMs: 5000 },
    ]);
  });

  test("explicit null healthChecks stores null", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      healthChecks: null,
    });
    expect(spec.healthChecksJson).toBeNull();
  });
});

describe("defineStep — signals", () => {
  test("key defaults to sourcePath, type is derived from result schema", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      result: z.object({
        score: z.number(),
        label: z.string(),
        active: z.boolean(),
        tags: z.array(z.string()),
        meta: z.object({ value: z.number() }),
      }),
      signals: [
        { sourcePath: "score" },
        { sourcePath: "label" },
        { sourcePath: "active" },
        { sourcePath: "tags" },
        { sourcePath: "meta" },
        { sourcePath: "meta.value" },
      ],
    });

    const defs = spec.signalExtractorDefinitions;
    expect(defs[0]).toEqual({
      key: "score",
      sourcePath: "score",
      type: "number",
      required: true,
      availableWhenResultStatusIn: null,
    });
    expect(defs[1]).toEqual({
      key: "label",
      sourcePath: "label",
      type: "string",
      required: true,
      availableWhenResultStatusIn: null,
    });
    expect(defs[2]).toEqual({
      key: "active",
      sourcePath: "active",
      type: "boolean",
      required: true,
      availableWhenResultStatusIn: null,
    });
    expect(defs[3]).toEqual({
      key: "tags",
      sourcePath: "tags",
      type: "array",
      required: true,
      availableWhenResultStatusIn: null,
    });
    expect(defs[4]).toEqual({
      key: "meta",
      sourcePath: "meta",
      type: "object",
      required: true,
      availableWhenResultStatusIn: null,
    });
    expect(defs[5]).toEqual({
      key: "meta.value",
      sourcePath: "meta.value",
      type: "number",
      required: true,
      availableWhenResultStatusIn: null,
    });
  });

  test("explicit key and required override auto-derivation", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      result: z.object({ score: z.number() }),
      signals: [{ key: "custom_key", sourcePath: "score", required: false }],
    });

    expect(spec.signalExtractorDefinitions[0]).toEqual({
      key: "custom_key",
      sourcePath: "score",
      type: "number",
      required: false,
      availableWhenResultStatusIn: null,
    });
  });
});
