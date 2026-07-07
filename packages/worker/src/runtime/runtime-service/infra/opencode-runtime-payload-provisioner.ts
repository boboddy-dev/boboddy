import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
  PAYLOAD_MANIFEST_FILENAME,
  containerOpencodeRuntimeVersionDir,
  hostOpencodeRuntimeRoot,
  hostOpencodeRuntimeVersionDir,
  opencodePlatformPackage,
  resolveHostHome,
  resolveHostNativePlatform,
  resolveOpencodeRuntimeVersion,
  type OpencodeRuntimePayloadManifest,
  type PayloadPlatform,
} from "../domain/opencode-runtime-payload";
import { buildOpencodeLaunchWrapper } from "./opencode-runtime-launch-wrapper";

const execFileAsync = promisify(execFile);

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
 * The standalone binaries are sourced from the `opencode-<platform>` npm
 * optional-dependency packages of `opencode-ai` (each ships a single,
 * embedded-Bun ELF executable). They are downloaded and extracted with the
 * registry tarball + system `tar`, which is universally available on worker
 * hosts.
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

  constructor(options: OpencodeRuntimePayloadProvisionerOptions = {}) {
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
    } else {
      await this.provision(version, hostPayloadDir);
    }

    await this.gcStaleVersions(version);

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
    const manifest = await this.readManifest(hostPayloadDir);
    if (
      !manifest ||
      manifest.version !== version ||
      manifest.formatRevision !== PAYLOAD_FORMAT_REVISION
    ) {
      return false;
    }
    for (const platform of this.platforms) {
      const binaryPath = path.join(
        hostPayloadDir,
        PAYLOAD_BIN_SUBDIR,
        platform,
        "opencode",
      );
      if (!(await fileExists(binaryPath))) {
        return false;
      }
    }
    return true;
  }

  private async readManifest(
    hostPayloadDir: string,
  ): Promise<OpencodeRuntimePayloadManifest | undefined> {
    try {
      const raw = await readFile(
        path.join(hostPayloadDir, PAYLOAD_MANIFEST_FILENAME),
        "utf8",
      );
      const parsed = JSON.parse(raw) as OpencodeRuntimePayloadManifest;
      return parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * Build the payload in a staging dir and atomically rename it into place.
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

    const cacheRoot = hostOpencodeRuntimeRoot(this.homeDir);
    await mkdir(cacheRoot, { recursive: true });

    const stagingDir = await mkdtemp(
      path.join(cacheRoot, `.staging-${version}-`),
    );

    try {
      const provisionedPlatforms: PayloadPlatform[] = [];
      for (const platform of this.platforms) {
        await this.provisionPlatform(version, platform, stagingDir);
        provisionedPlatforms.push(platform);
      }

      await this.writeLaunchWrapper(stagingDir);
      await this.writeManifest(stagingDir, version, provisionedPlatforms);

      // Atomic publish: remove any partial/old dir, then rename staging in.
      await rm(hostPayloadDir, { recursive: true, force: true });
      await rename(stagingDir, hostPayloadDir);

      logWork("runtime", "OpenCode runtime payload provisioned", {
        version,
        hostPayloadDir,
        platforms: provisionedPlatforms,
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

  /**
   * Download the `opencode-<platform>` registry tarball and extract its single
   * `package/bin/opencode` binary into `<staging>/bin/<platform>/opencode`.
   */
  private async provisionPlatform(
    version: string,
    platform: PayloadPlatform,
    stagingDir: string,
  ): Promise<void> {
    const pkg = opencodePlatformPackage(platform);
    const tarballUrl = `${this.registryBaseUrl}/${pkg}/-/${pkg}-${version}.tgz`;

    const downloadDir = await mkdtemp(
      path.join(os.tmpdir(), `oc-payload-${platform}-`),
    );
    const tarballPath = path.join(downloadDir, "package.tgz");
    const extractDir = path.join(downloadDir, "extract");

    try {
      logWorkDebug("runtime", "Downloading OpenCode platform binary", {
        version,
        platform,
        tarballUrl,
      });
      const response = await fetch(tarballUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download ${pkg}@${version} (${tarballUrl}): ` +
            `HTTP ${String(response.status)}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(tarballPath, bytes);

      await mkdir(extractDir, { recursive: true });
      // System tar is universally present on worker hosts; the tarball is a
      // standard gzipped npm package with `package/bin/opencode`.
      await execFileAsync("tar", [
        "-xzf",
        tarballPath,
        "-C",
        extractDir,
        "package/bin/opencode",
      ]);

      const extractedBinary = path.join(
        extractDir,
        "package",
        "bin",
        "opencode",
      );
      if (!(await fileExists(extractedBinary))) {
        throw new Error(
          `Extracted ${pkg}@${version} but bin/opencode was not present`,
        );
      }

      const destDir = path.join(stagingDir, PAYLOAD_BIN_SUBDIR, platform);
      await mkdir(destDir, { recursive: true });
      const destBinary = path.join(destDir, "opencode");
      // Move within the same temp filesystem then copy into the cache dir.
      const contents = await readFile(extractedBinary);
      await writeFile(destBinary, contents);
      await chmod(destBinary, 0o755);
    } finally {
      await rm(downloadDir, { recursive: true, force: true });
    }
  }

  private async writeLaunchWrapper(stagingDir: string): Promise<void> {
    const wrapperPath = path.join(stagingDir, LAUNCH_WRAPPER_FILENAME);
    await writeFile(wrapperPath, buildOpencodeLaunchWrapper(), "utf8");
    await chmod(wrapperPath, 0o755);
  }

  private async writeManifest(
    stagingDir: string,
    version: string,
    platforms: PayloadPlatform[],
  ): Promise<void> {
    const manifest: OpencodeRuntimePayloadManifest = {
      version,
      platforms,
      provisionedAt: new Date().toISOString(),
      formatRevision: PAYLOAD_FORMAT_REVISION,
    };
    await writeFile(
      path.join(stagingDir, PAYLOAD_MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  /**
   * GC payload versions other than the pinned one. Reused payloads are cached,
   * so on a version bump older directories accumulate; remove them. Staging
   * dirs (prefixed `.staging-`) left by aborted provisions are also swept.
   */
  private async gcStaleVersions(keepVersion: string): Promise<void> {
    const cacheRoot = hostOpencodeRuntimeRoot(this.homeDir);
    let entries: string[];
    try {
      entries = await readdir(cacheRoot);
    } catch {
      return;
    }

    for (const entry of entries) {
      const isStaging = entry.startsWith(".staging-");
      if (entry === keepVersion && !isStaging) {
        continue;
      }
      const target = path.join(cacheRoot, entry);
      try {
        await rm(target, { recursive: true, force: true });
        logWorkDebug("runtime", "GC'd stale OpenCode runtime payload", {
          entry,
          keepVersion,
        });
      } catch (error) {
        logWorkDebug("runtime", "Failed to GC OpenCode runtime payload entry", {
          entry,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
