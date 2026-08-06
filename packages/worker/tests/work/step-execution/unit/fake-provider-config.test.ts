import { describe, expect, test } from "bun:test";
import {
  buildFakeProviderConfig,
  FAKE_MODEL_ID,
  FAKE_PROVIDER_ID,
} from "../../../../src/work/step-execution/infra/fake-ai/fake-provider-config";

describe("buildFakeProviderConfig", () => {
  test("returns the exact expected config shape for the given base URL", () => {
    const fakeAiBaseUrl = "http://host.docker.internal:4097";

    const config = buildFakeProviderConfig(fakeAiBaseUrl);

    expect(config).toEqual({
      provider: {
        "boboddy-fake": {
          npm: "@ai-sdk/anthropic",
          name: "Boboddy Fake Canary Provider",
          options: { baseURL: fakeAiBaseUrl, apiKey: "fake-key" },
          models: { "boboddy-fake-canary": { name: "Boboddy Fake Canary Model" } },
        },
      },
    });
  });

  test("registers exactly one provider, under FAKE_PROVIDER_ID", () => {
    const config = buildFakeProviderConfig("http://127.0.0.1:4097");

    expect(Object.keys(config.provider ?? {})).toEqual([FAKE_PROVIDER_ID]);
  });

  test("pins npm to the Anthropic SDK so the wire protocol matches FakeAiServer", () => {
    // FakeAiServer speaks the Anthropic Messages API (`POST /messages`). An
    // unknown provider id with no `npm` falls back to
    // `@ai-sdk/openai-compatible`, which POSTs `/chat/completions` and 404s.
    const config = buildFakeProviderConfig("http://127.0.0.1:4097");

    expect(config.provider?.[FAKE_PROVIDER_ID]?.npm).toBe("@ai-sdk/anthropic");
  });

  test("declares the canary model inline, since no models.dev entry exists for a synthetic id", () => {
    const config = buildFakeProviderConfig("http://127.0.0.1:4097");

    expect(config.provider?.[FAKE_PROVIDER_ID]?.models).toEqual({
      [FAKE_MODEL_ID]: { name: "Boboddy Fake Canary Model" },
    });
  });

  test("reflects a different base URL each call rather than caching a prior one", () => {
    const first = buildFakeProviderConfig("http://127.0.0.1:1111");
    const second = buildFakeProviderConfig("http://127.0.0.1:2222");

    expect(first.provider?.[FAKE_PROVIDER_ID]?.options?.baseURL).toBe("http://127.0.0.1:1111");
    expect(second.provider?.[FAKE_PROVIDER_ID]?.options?.baseURL).toBe("http://127.0.0.1:2222");
  });
});

describe("FAKE_PROVIDER_ID", () => {
  /**
   * Registering the fake provider under a real provider id lets a user's own
   * credential (`auth.json`, env var, OAuth token) or a provider-scoped plugin
   * in their OpenCode config bind to it and hijack the canary session, which
   * made every canary fail. The id must stay synthetic.
   */
  const REAL_PROVIDER_IDS = [
    "anthropic",
    "openai",
    "google",
    "google-vertex",
    "github-copilot",
    "amazon-bedrock",
    "azure",
    "openrouter",
    "mistral",
    "groq",
    "deepseek",
    "xai",
    "cerebras",
    "togetherai",
    "fireworks-ai",
    "ollama",
    "opencode",
  ];

  test("is not any real provider id", () => {
    expect(REAL_PROVIDER_IDS).not.toContain(FAKE_PROVIDER_ID);
  });

  test("is namespaced to boboddy so it cannot collide with a future registry id", () => {
    expect(FAKE_PROVIDER_ID.startsWith("boboddy-")).toBe(true);
  });
});
