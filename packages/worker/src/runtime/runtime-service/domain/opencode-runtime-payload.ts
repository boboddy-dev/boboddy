import os from "node:os";
import path from "node:path";

/**
 * Domain definition of the Boboddy-managed OpenCode runtime payload.
 *
 * Per the locked migration decision, OpenCode is NEVER launched from the
 * project Node / PATH / a global `opencode`. Instead a pinned, Boboddy-owned
 * runtime payload is cached on the host, mounted into the devcontainer, and
 * launched by ABSOLUTE PATH via a wrapper script.
 *
 * Payload layout (host cache, keyed by version):
 *
 *   ~/.boboddy/runtimes/opencode/<version>/
 *     manifest.json                         # version + provisioned platforms
 *     launch.sh                             # arch/libc-detecting launch wrapper
 *     bin/<platform>/opencode               # standalone, embedded-Bun binaries
 *       linux-arm64/opencode                #   glibc arm64
 *       linux-x64/opencode                  #   glibc x64
 *       linux-arm64-musl/opencode           #   musl  arm64 (Alpine)
 *       linux-x64-musl/opencode             #   musl  x64   (Alpine)
 *
 * The same directory is bind-mounted into the container at
 * `/opt/boboddy/runtimes/opencode/<version>` and `launch.sh` is invoked by its
 * absolute container path. `launch.sh` inspects `uname -m` and whether the
 * container's libc is musl (Alpine) vs glibc to pick the correct binary, so a
 * single mounted payload is portable across arbitrary devcontainer base images
 * (the "Runtime payload portability" risk in the plan).
 */

/**
 * Pinned OpenCode runtime version. This is the single source of truth for which
 * OpenCode the worker provisions/mounts. Bumping it changes the cache key
 * (`~/.boboddy/runtimes/opencode/<version>`), causing a fresh provision and GC
 * of older versions on next launch.
 *
 * This constant is the single pin for the in-devcontainer OpenCode runtime.
 */
export const OPENCODE_RUNTIME_VERSION = "1.17.3";

/**
 * Override the pinned version via the worker env (e.g. for local dev).
 */
export const OPENCODE_RUNTIME_VERSION_ENV = "BOBODDY_OPENCODE_RUNTIME_VERSION";

/** Resolve the effective pinned OpenCode runtime version. */
export function resolveOpencodeRuntimeVersion(
  env: (name: string) => string | undefined = (name) => process.env[name],
): string {
  const override = env(OPENCODE_RUNTIME_VERSION_ENV)?.trim();
  return override && override.length > 0 ? override : OPENCODE_RUNTIME_VERSION;
}

/**
 * Container mount root for Boboddy-managed runtimes. The version-specific
 * payload is mounted at `<root>/opencode/<version>`.
 */
export const CONTAINER_RUNTIME_ROOT = "/opt/boboddy/runtimes";

/** Host cache root: `~/.boboddy/runtimes`. */
export const HOST_RUNTIME_CACHE_RELATIVE = [".boboddy", "runtimes"] as const;

/** Wrapper script filename inside the payload, invoked by absolute path. */
export const LAUNCH_WRAPPER_FILENAME = "launch.sh";

/** Manifest filename inside the payload. */
export const PAYLOAD_MANIFEST_FILENAME = "manifest.json";

/** Subdirectory holding the per-platform standalone binaries. */
export const PAYLOAD_BIN_SUBDIR = "bin";

/**
 * Standalone-binary platform keys we provision. Each maps to an npm
 * optional-dependency package of `opencode-ai` (e.g. `opencode-linux-arm64`).
 * Only Linux targets are provisioned — the payload only ever runs inside a
 * (Linux) devcontainer. Both glibc and musl (Alpine) variants are included so
 * the payload is portable across base images.
 */
export const PAYLOAD_PLATFORMS = [
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
] as const;

export type PayloadPlatform = (typeof PAYLOAD_PLATFORMS)[number];

/**
 * Resolve the host home directory, honoring an explicit `HOME` override. On
 * macOS `os.homedir()` reads the OS user database and ignores `process.env`,
 * so prefer the env var when set. Mirrors the launcher's `resolveHostHome`.
 */
export function resolveHostHome(
  env: (name: string) => string | undefined = (name) => process.env[name],
): string {
  const explicit = env("HOME")?.trim();
  return explicit && explicit.length > 0 ? explicit : os.homedir();
}

/** Host cache root for OpenCode runtimes: `~/.boboddy/runtimes/opencode`. */
export function hostOpencodeRuntimeRoot(homeDir: string): string {
  return path.join(homeDir, ...HOST_RUNTIME_CACHE_RELATIVE, "opencode");
}

/** Host directory for a specific pinned version's payload. */
export function hostOpencodeRuntimeVersionDir(
  homeDir: string,
  version: string,
): string {
  return path.join(hostOpencodeRuntimeRoot(homeDir), version);
}

/**
 * Container mount target for a specific pinned version's payload. The host
 * `hostOpencodeRuntimeVersionDir` is bind-mounted here read-only.
 */
export function containerOpencodeRuntimeVersionDir(version: string): string {
  return path.posix.join(CONTAINER_RUNTIME_ROOT, "opencode", version);
}

/**
 * Absolute container path of the launch wrapper for a pinned version. This is
 * the ONLY entrypoint the bootstrapper invokes — never a PATH lookup.
 */
export function containerLaunchWrapperPath(version: string): string {
  return path.posix.join(
    containerOpencodeRuntimeVersionDir(version),
    LAUNCH_WRAPPER_FILENAME,
  );
}

/** npm package name supplying the standalone binary for a payload platform. */
export function opencodePlatformPackage(platform: PayloadPlatform): string {
  return `opencode-${platform}`;
}

/** Shape persisted to `manifest.json` inside the payload. */
export type OpencodeRuntimePayloadManifest = {
  /** Pinned OpenCode version this payload provides. */
  version: string;
  /** Platform binaries successfully provisioned. */
  platforms: PayloadPlatform[];
  /** ISO timestamp the payload was provisioned. */
  provisionedAt: string;
  /** Payload format revision, bumped if the layout/wrapper contract changes. */
  formatRevision: number;
};

/**
 * Payload format revision. Bump when the on-disk layout or wrapper contract
 * changes in a way that makes previously-cached payloads incompatible; the
 * provisioner treats a manifest with a different revision as stale.
 */
export const PAYLOAD_FORMAT_REVISION = 1;
