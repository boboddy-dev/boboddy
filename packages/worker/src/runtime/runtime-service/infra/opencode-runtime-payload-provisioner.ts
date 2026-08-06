import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  logWork,
  logWorkDebug,
  logWorkError,
} from "../../../work/step-execution/application/work-logger";
import {
  LAUNCH_WRAPPER_FILENAME,
  LINUX_PAYLOAD_PLATFORMS,
  PAYLOAD_BIN_SUBDIR,
  PAYLOAD_FORMAT_REVISION,
  containerOpencodeRuntimeVersionDir,
  hostOpencodeRuntimeRoot,
  hostOpencodeRuntimeVersionDir,
  resolveHostHome,
  resolveHostNativePlatform,
  resolveOpencodeRuntimeVersion,
  type OpencodePayloadProgressListener,
  type PayloadPlatform,
} from "../domain/opencode-runtime-payload";
import { fetchOpencodePlatformBinary } from "./opencode-platform-binary-fetcher";
import {
  carryForwardCachedPlatforms,
  gcStalePayloadVersions,
  payloadBinaryPath,
  payloadFileExists,
  readPayloadManifest,
  writePayloadManifest,
} from "./opencode-runtime-payload-cache";
import { buildOpencodeLaunchWrapper } from "./opencode-runtime-launch-wrapper";

/**
 * Provisions the Boboddy-managed OpenCode runtime payload into the host cache
 * (`~/.boboddy/runtimes/opencode/<version>`), version-pinned and reused across
 * sessions, and GCs stale versions.
 *
 * Provisioning is idempotent: an existing, valid payload (matching version +
 * format revision, with all expected platform binaries present) is reused
 * as-is. Otherwise the version dir is rebuilt atomically (staged in a temp dir,
 * then renamed into place) so concurrent/aborted provisions never leave a
 * partial payload mounted into a container.
 *
 * Provisioning is also ADDITIVE: platform binaries already cached for the same
 * version but outside the requested `platforms` set are carried forward into the
 * new payload (see `opencode-runtime-payload-cache.ts`). Callers request
 * different subsets of the same shared cache — the worker needs the full Linux
 * set, the CLI's interactive TUI needs only the host-native binary.
 *
 * The standalone binaries are sourced from the `opencode-<platform>` npm
 * optional-dependency packages of `opencode-ai` (each ships a single,
 * embedded-Bun ELF executable). Download + extraction lives in
 * `opencode-platform-binary-fetcher.ts`.
 */

export type OpencodeRuntimePayloadLocation = {
  /** Pinned version provisioned. */
  version: string;
  /** Absolute host path of the version payload dir (the mount source). */
  hostPayloadDir: string;
  /** Absolute container path the payload is mounted at (the mount target). */
  containerPayloadDir: string;
  /** Absolute container path of the launch wrapper (the launch entrypoint). */
  containerLaunchWrapperPath: string;
};

export type OpencodeRuntimePayloadProvisionerOptions = {
  /** Host home dir override (tests). Defaults to resolved `HOME`/os.homedir(). */
  homeDir?: string | undefined;
  /** npm registry base URL. Defaults to the public registry. */
  registryBaseUrl?: string | undefined;
  /**
   * Override the set of platform binaries to provision. Defaults to the Linux
   * set (always, for the mounted devcontainer payload) plus the current
   * host-native platform (for `no_workspace` host runs). Narrowing this is only
   * useful in tests — a real payload must carry every Linux variant to stay
   * portable across base images.
   */
  platforms?: readonly PayloadPlatform[] | undefined;
  /**
   * Override the resolved host-native platform (tests). Defaults to
   * {@link resolveHostNativePlatform} for the current process. `null` means the
   * host is unsupported for host execution and only the Linux set is provisioned.
   */
  hostNativePlatform?: PayloadPlatform | null | undefined;
  /**
   * Optional progress sink for interactive callers (the CLI renders a download
   * spinner). Never receives secrets.
   */
  onProgress?: OpencodePayloadProgressListener | undefined;
};

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * The default provisioned platform set: the always-required Linux binaries plus
 * the current host-native platform (deduped — on Linux hosts the host-native
 * key is already in the Linux set, so only macOS hosts add a binary).
 */
export function resolveDefaultPayloadPlatforms(
  hostNativePlatform: PayloadPlatform | null,
): readonly PayloadPlatform[] {
  if (
    hostNativePlatform === null ||
    LINUX_PAYLOAD_PLATFORMS.includes(
      hostNativePlatform as (typeof LINUX_PAYLOAD_PLATFORMS)[number],
    )
  ) {
    return LINUX_PAYLOAD_PLATFORMS;
  }
  return [...LINUX_PAYLOAD_PLATFORMS, hostNativePlatform];
}

export class OpencodeRuntimePayloadProvisioner {
  private readonly homeDir: string;
  private readonly registryBaseUrl: string;
  private readonly platforms: readonly PayloadPlatform[];
  private readonly onProgress: OpencodePayloadProgressListener | undefined;

  constructor(options: OpencodeRuntimePayloadProvisionerOptions = {}) {
    this.onProgress = options.onProgress;
    this.homeDir = options.homeDir ?? resolveHostHome();
    this.registryBaseUrl = (
      options.registryBaseUrl ?? DEFAULT_REGISTRY
    ).replace(/\/+$/u, "");
    const hostNativePlatform =
      options.hostNativePlatform === undefined
        ? resolveHostNativePlatform()
        : options.hostNativePlatform;
    this.platforms =
      options.platforms ?? resolveDefaultPayloadPlatforms(hostNativePlatform);
  }

  /**
   * Ensure the pinned payload exists in the host cache, provisioning it if
   * needed, then GC stale versions. Returns the host + container locations the
   * bootstrapper uses to inject the mount and launch by absolute path.
   */
  async ensure(): Promise<OpencodeRuntimePayloadLocation> {
    const version = resolveOpencodeRuntimeVersion();
    const hostPayloadDir = hostOpencodeRuntimeVersionDir(this.homeDir, version);

    if (await this.isValidPayload(hostPayloadDir, version)) {
      logWorkDebug("runtime", "OpenCode runtime payload cache hit", {
        version,
        hostPayloadDir,
      });
      this.onProgress?.({ phase: "cache-hit", version });
    } else {
      await this.provision(version, hostPayloadDir);
    }

    await gcStalePayloadVersions(
      hostOpencodeRuntimeRoot(this.homeDir),
      version,
    );

    return {
      version,
      hostPayloadDir,
      containerPayloadDir: containerOpencodeRuntimeVersionDir(version),
      containerLaunchWrapperPath: path.posix.join(
        containerOpencodeRuntimeVersionDir(version),
        LAUNCH_WRAPPER_FILENAME,
      ),
    };
  }

  /**
   * A payload is valid when its manifest matches the pinned version and the
   * current format revision, and every expected platform binary is present.
   */
  private async isValidPayload(
    hostPayloadDir: string,
    version: string,
  ): Promise<boolean> {
    const manifest = await readPayloadManifest(hostPayloadDir);
    if (
      !manifest ||
      manifest.version !== version ||
      manifest.formatRevision !== PAYLOAD_FORMAT_REVISION
    ) {
      return false;
    }
    for (const platform of this.platforms) {
      if (
        !(await payloadFileExists(payloadBinaryPath(hostPayloadDir, platform)))
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Build the payload in a staging dir and atomically rename it into place.
   *
   * Provisioning is ADDITIVE: platform binaries already cached for this same
   * version/format revision but NOT in `this.platforms` are carried forward into
   * the staging dir. Different callers request different platform subsets (the
   * worker needs the full Linux set to mount into a devcontainer; the CLI's
   * interactive TUI needs only the host-native binary), and they share one
   * version-keyed cache directory. Without the carry-forward, each caller's
   * atomic republish would delete the other's binaries and the two would
   * re-download ~100 MB apiece in a loop.
   */
  private async provision(
    version: string,
    hostPayloadDir: string,
  ): Promise<void> {
    logWork("runtime", "Provisioning OpenCode runtime payload", {
      version,
      hostPayloadDir,
      platforms: [...this.platforms],
    });
    this.onProgress?.({
      phase: "provision-start",
      version,
      platforms: this.platforms,
    });

    const cacheRoot = hostOpencodeRuntimeRoot(this.homeDir);
    await mkdir(cacheRoot, { recursive: true });

    const stagingDir = await mkdtemp(
      path.join(cacheRoot, `.staging-${version}-`),
    );

    try {
      const total = this.platforms.length;
      const provisionedPlatforms: PayloadPlatform[] = [];
      for (const [index, platform] of this.platforms.entries()) {
        this.onProgress?.({
          phase: "platform-start",
          version,
          platform,
          index,
          total,
        });
        const { bytes } = await fetchOpencodePlatformBinary({
          version,
          platform,
          registryBaseUrl: this.registryBaseUrl,
          destinationPath: path.join(
            stagingDir,
            PAYLOAD_BIN_SUBDIR,
            platform,
            "opencode",
          ),
          onProgress: this.onProgress,
        });
        provisionedPlatforms.push(platform);
        this.onProgress?.({
          phase: "platform-done",
          version,
          platform,
          index,
          total,
          bytes,
        });
      }

      const carried = await carryForwardCachedPlatforms({
        hostPayloadDir,
        stagingDir,
        version,
        requestedPlatforms: this.platforms,
      });
      const allPlatforms = [...provisionedPlatforms, ...carried];

      await this.writeLaunchWrapper(stagingDir);
      await writePayloadManifest(stagingDir, version, allPlatforms);

      // Atomic publish: remove any partial/old dir, then rename staging in.
      await rm(hostPayloadDir, { recursive: true, force: true });
      await rename(stagingDir, hostPayloadDir);

      logWork("runtime", "OpenCode runtime payload provisioned", {
        version,
        hostPayloadDir,
        platforms: allPlatforms,
        carriedForward: carried,
      });
      this.onProgress?.({
        phase: "provision-done",
        version,
        platforms: allPlatforms,
      });
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      logWorkError("runtime", "OpenCode runtime payload provisioning failed", {
        version,
        hostPayloadDir,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async writeLaunchWrapper(stagingDir: string): Promise<void> {
    const wrapperPath = path.join(stagingDir, LAUNCH_WRAPPER_FILENAME);
    await writeFile(wrapperPath, buildOpencodeLaunchWrapper(), "utf8");
    await chmod(wrapperPath, 0o755);
  }
}
