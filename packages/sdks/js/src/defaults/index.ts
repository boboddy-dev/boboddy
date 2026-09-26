export {
  deleteAuthProfile,
  getAuthFilePath,
  loadAuthFile,
  loadAuthProfile,
  saveAuthProfile,
} from "./auth-file";
export type { AuthFile, AuthProfile } from "./auth-file";
export {
  getArtifactRetentionSettings,
  getConfigFilePath,
  getOrCreateAnonymousId,
  isTelemetryDisabled,
  loadConfigFile,
  setTelemetryDisabled,
} from "./config-file";
export type { ArtifactRetentionSettings, ConfigFile } from "./config-file";
// Test-only, but exported here (rather than a deeper subpath) because
// `packages/sdks/js/package.json`'s `exports` map only exposes `./defaults`
// as a whole, and other workspaces (e.g. `packages/worker`'s tests) need to
// redirect `resolveHomeDir()` at a scratch directory the same way this
// package's own tests do.
export { setHomeDirForTests } from "./home-dir";
export { resolveBoboddyBaseUrl } from "./base-url";
export {
  loadProjectConfig,
  PROJECT_CONFIG_RELATIVE_PATH,
} from "./project-config";
export type { ProjectConfig } from "./project-config";
export { loadPushDefaults } from "./load-push-defaults";
export type {
  LoadPushDefaultsOptions,
  PushDefaults,
} from "./load-push-defaults";
