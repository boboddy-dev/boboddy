/**
 * Builds the OpenCode `Config` block that registers a synthetic provider
 * pointed at a {@link FakeAiServer}. This is the launch-time counterpart to
 * the (proven ineffective — see #109) runtime `PATCH /config` approach: an
 * already-running OpenCode agent never picks up a post-boot config PATCH, so
 * the fix is to bake this same block into the config the agent reads at
 * process start instead. Extracted as a pure function so both the launch-time
 * config seeder and (for now, still separately) the dry-run MCP health check
 * can build the identical block from one source of truth.
 */
import type { Config } from "@opencode-ai/sdk";
import { resolveFakeAiHost } from "./seed-opencode-config";
import type { FakeAiServer } from "./fake-ai-server";

/**
 * Deliberately synthetic: it matches no real provider id, and no models.dev
 * registry entry, so no user credential (`auth.json`, `OPENAI_API_KEY`-style
 * env var, OAuth token) and no provider-scoped plugin in the user's own
 * OpenCode config can bind to it and hijack the health check session.
 * Registering under a real id such as `anthropic` collided with exactly that
 * and made every health check fail for users who had that provider
 * configured.
 *
 * Exported so callers that need to select this provider/model at prompt time
 * (e.g. `forceAndVerifyMcpHealthCheck`'s `promptAsync` call) reference the
 * same constant instead of re-declaring the string literal, which would
 * silently drift out of sync with this file.
 */
export const FAKE_PROVIDER_ID = "boboddy-healthchecker";
/**
 * Distinct from any real model id so it can never collide with one. Exported
 * for the same reason as {@link FAKE_PROVIDER_ID}.
 */
export const FAKE_MODEL_ID = "boboddy-healthchecker-model";
const FAKE_MODEL_NAME = "Boboddy Health Checker (internal)";
const FAKE_PROVIDER_NAME = "Boboddy Health Checker (internal)";
const FAKE_PROVIDER_API_KEY = "fake-key";
/**
 * Selects the wire protocol OpenCode speaks to `baseURL`, and MUST stay in
 * sync with {@link FakeAiServer}, which implements the Anthropic Messages API
 * (`POST /messages`). An unknown provider id defaults to
 * `@ai-sdk/openai-compatible`, which POSTs `/chat/completions` and 404s
 * against the fake server. No install happens at runtime: `@ai-sdk/anthropic`
 * is one of the provider SDKs bundled into the OpenCode binary.
 */
const FAKE_PROVIDER_NPM = "@ai-sdk/anthropic";

/**
 * Registers the synthetic {@link FAKE_PROVIDER_ID} provider pointed at the
 * fake-LLM server listening at `fakeAiBaseUrl`. Returns a `Partial<Config>`
 * suitable for merging into the launch-time OpenCode config so the fake
 * provider is live from the moment the agent process boots, rather than
 * requiring a runtime `/config` PATCH.
 *
 * `models` must be declared inline: an id with no models.dev entry gets an
 * empty model map from the registry, so the inline declaration is the only
 * way the health check's model resolves.
 */
export function buildFakeProviderConfig(
  fakeAiBaseUrl: string,
): Partial<Config> {
  return {
    provider: {
      [FAKE_PROVIDER_ID]: {
        npm: FAKE_PROVIDER_NPM,
        name: FAKE_PROVIDER_NAME,
        options: { baseURL: fakeAiBaseUrl, apiKey: FAKE_PROVIDER_API_KEY },
        models: { [FAKE_MODEL_ID]: { name: FAKE_MODEL_NAME } },
      },
    },
  };
}

/**
 * Computes the base URL a launched agent should use to reach `fakeAiServer`
 * for the fake-AI provider baked into its launch-time config (see
 * {@link buildFakeProviderConfig}). One source of truth for both the dry-run
 * MCP health check feature (`run-work-dry-run.ts`) and the real-execution
 * health check gate (`health-check-gate.ts`, #120), which otherwise would
 * each hand-roll the same host/port logic.
 *
 * `no_workspace` runs the agent directly on the host alongside the fake-LLM
 * server, reachable via loopback; `workspace` runs it inside a devcontainer,
 * which needs the Docker host-gateway alias instead.
 */
export function buildFakeAiProviderOverride(input: {
  fakeAiServer: Pick<FakeAiServer, "port">;
  isNoWorkspace: boolean;
}): { baseUrl: string } {
  const host = input.isNoWorkspace ? "127.0.0.1" : resolveFakeAiHost();
  return { baseUrl: `http://${host}:${String(input.fakeAiServer.port)}` };
}
