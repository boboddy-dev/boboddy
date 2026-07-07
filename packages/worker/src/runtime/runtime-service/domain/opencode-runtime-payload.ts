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
 *       darwin-arm64/opencode               #   macOS arm64 (host runs only)
 *       darwin-x64/opencode                 #   macOS x64   (host runs only)
 *
 * The Linux binaries are the ones bind-mounted into the (Linux) devcontainer.
 * The darwin binaries are provisioned only when the worker host is macOS, and
 * are used by the `no_workspace` path, which runs OpenCode DIRECTLY ON THE HOST
 * (no container). `launch.sh` picks the right binary for the current OS/arch.
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
 * Linux standalone-binary platform keys we ALWAYS provision. Each maps to an
 * npm optional-dependency package of `opencode-ai` (e.g. `opencode-linux-arm64`).
 * These are the targets that run inside the (Linux) devcontainer. Both glibc and
 * musl (Alpine) variants are included so the mounted payload is portable across
 * base images.
 */
export const LINUX_PAYLOAD_PLATFORMS = [
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
] as const;

/**
 * Host-native platform keys. These are provisioned IN ADDITION to the Linux set
 * when the worker host is not Linux, so `no_workspace` steps — which run
 * OpenCode DIRECTLY ON THE HOST (no devcontainer) — have a runnable binary for
 * the host OS/arch. Each also maps to an `opencode-<platform>` npm package.
 */
export const HOST_NATIVE_PAYLOAD_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
] as const;

/**
 * All platform keys that may appear in a payload. The provisioner always writes
 * the Linux set and additively writes the current host-native platform (§
 * {@link resolveHostNativePlatform}) when it is not already covered by the Linux
 * set (i.e. on macOS).
 */
export const PAYLOAD_PLATFORMS = [
  ...LINUX_PAYLOAD_PLATFORMS,
  ...HOST_NATIVE_PAYLOAD_PLATFORMS,
] as const;

export type PayloadPlatform = (typeof PAYLOAD_PLATFORMS)[number];

/**
 * Resolve the current host's native payload platform key (e.g.
 * `darwin-arm64` on Apple Silicon, `linux-x64` on a glibc x64 Linux worker), or
 * `null` if the host OS/arch is unsupported for host execution. This is what the
 * `no_workspace` host path needs to run OpenCode without a container.
 *
 * Note: Linux hosts resolve to their glibc Linux key, which is already in the
 * always-provisioned Linux set — so only macOS hosts add an extra binary.
 */
export function resolveHostNativePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PayloadPlatform | null {
  const archKey = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (archKey === null) {
    return null;
  }
  if (platform === "darwin") {
    return `darwin-${archKey}` as PayloadPlatform;
  }
  if (platform === "linux") {
    // Host Linux runs use the glibc Linux binary already in the Linux set.
    return `linux-${archKey}` as PayloadPlatform;
  }
  return null;
}

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
export const PAYLOAD_FORMAT_REVISION = 2;
