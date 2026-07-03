/**
 * Shared fake AI test harness. Single source of truth for the fake
 * Anthropic-compatible server and the OpenCode config that points at it. Used by
 * the worker integration tests and the `@boboddy/e2e-tests` CLI-to-server suite.
 */
export { FakeAiServer, type FakeAiServerOptions } from "./fake-ai-server";
export {
  seedOpencodeConfig,
  resolveFakeAiHost,
  type SeedOpencodeConfigOptions,
} from "./seed-opencode-config";
