/**
 * Values baked into the compiled binary by `script/build.ts` via
 * `bun build --define`. Each identifier below is replaced with a string
 * literal at build time; when the binary was built without it (or the
 * source runs unbundled under `bun run`), the `typeof` guard yields
 * `undefined` instead of throwing a ReferenceError.
 *
 * The identifier names are part of the contract with `script/build.ts`
 * ({@link BAKED_POSTHOG_CLI_KEY_DEFINE}, {@link BAKED_POSTHOG_CLI_HOST_DEFINE}).
 */

declare const __BOBODDY_POSTHOG_CLI_KEY__: string | undefined;
declare const __BOBODDY_POSTHOG_CLI_HOST__: string | undefined;

export const BAKED_POSTHOG_CLI_KEY_DEFINE = "__BOBODDY_POSTHOG_CLI_KEY__";
export const BAKED_POSTHOG_CLI_HOST_DEFINE = "__BOBODDY_POSTHOG_CLI_HOST__";

export type BakedTelemetryConfig = { key?: string; host?: string };

export function bakedTelemetryConfig(): BakedTelemetryConfig {
  return {
    key:
      typeof __BOBODDY_POSTHOG_CLI_KEY__ === "string"
        ? __BOBODDY_POSTHOG_CLI_KEY__
        : undefined,
    host:
      typeof __BOBODDY_POSTHOG_CLI_HOST__ === "string"
        ? __BOBODDY_POSTHOG_CLI_HOST__
        : undefined,
  };
}
