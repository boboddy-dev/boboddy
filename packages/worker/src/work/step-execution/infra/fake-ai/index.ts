/**
 * Fake AI provider infrastructure. Single source of truth for the fake
 * Anthropic-compatible server and the OpenCode config that points at it. Used
 * by the worker integration tests, the `@boboddy/e2e-tests` CLI-to-server
 * suite, and (indirectly) the dry-run canary feature that forces arbitrary MCP
 * tool calls through a real OpenCode session.
 */
export {
  FakeAiServer,
  type FakeAiServerOptions,
  type FakeAiForcedToolCall,
} from "./fake-ai-server";
export {
  seedOpencodeConfig,
  resolveFakeAiHost,
  type SeedOpencodeConfigOptions,
} from "./seed-opencode-config";
export {
  buildFakeProviderConfig,
  FAKE_PROVIDER_ID,
  FAKE_MODEL_ID,
} from "./fake-provider-config";
