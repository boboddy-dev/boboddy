import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { logWorkDebug } from "../../../work/step-execution/application/work-logger";
import {
  PAYLOAD_BIN_SUBDIR,
  PAYLOAD_FORMAT_REVISION,
  PAYLOAD_MANIFEST_FILENAME,
  type OpencodeRuntimePayloadManifest,
  type PayloadPlatform,
} from "../domain/opencode-runtime-payload";

/**
 * On-disk cache helpers for the OpenCode runtime payload: manifest read/write,
 * cross-caller platform carry-forward, and stale-version GC.
 *
 * Split out of {@link OpencodeRuntimePayloadProvisioner} purely so both files
 * stay inside the per-file line limit; the provisioner remains the only caller.
 */

/** Absolute path of a platform's standalone binary inside a payload dir. */
export function payloadBinaryPath(
  payloadDir: string,
  platform: PayloadPlatform,
): string {
  return path.join(payloadDir, PAYLOAD_BIN_SUBDIR, platform, "opencode");
}

/** Read a payload manifest, or `undefined` if missing/unparseable. */
export async function readPayloadManifest(
  payloadDir: string,
): Promise<OpencodeRuntimePayloadManifest | undefined> {
  try {
    const raw = await readFile(
      path.join(payloadDir, PAYLOAD_MANIFEST_FILENAME),
      "utf8",
    );
    return JSON.parse(raw) as OpencodeRuntimePayloadManifest;
  } catch {
    return undefined;
  }
}

/** Write the payload manifest into a (staging) payload dir. */
export async function writePayloadManifest(
  payloadDir: string,
  version: string,
  platforms: readonly PayloadPlatform[],
): Promise<void> {
  const manifest: OpencodeRuntimePayloadManifest = {
    version,
    platforms: [...platforms],
    provisionedAt: new Date().toISOString(),
    formatRevision: PAYLOAD_FORMAT_REVISION,
  };
  await writeFile(
    path.join(payloadDir, PAYLOAD_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export type CarryForwardCachedPlatformsInput = {
  /** Existing (published) payload dir to salvage binaries from. */
  hostPayloadDir: string;
  /** Staging dir about to replace it. */
  stagingDir: string;
  /** Version being provisioned. */
  version: string;
  /** Platforms the current provision already produced. */
  requestedPlatforms: readonly PayloadPlatform[];
};

/**
 * Copy still-valid platform binaries from an existing cached payload into the
 * staging dir, returning the platforms carried over.
 *
 * Different callers request different platform subsets while sharing one
 * version-keyed cache directory: the worker needs the full Linux set to mount
 * into a devcontainer, the CLI's interactive TUI needs only the host-native
 * binary. Without this carry-forward each caller's atomic republish would
 * delete the other's binaries and the two would re-download ~100 MB apiece in a
 * loop.
 *
 * Only applies when the cached manifest is for the SAME version and format
 * revision — otherwise the cached binaries are the wrong build and must not
 * survive the republish.
 */
export async function carryForwardCachedPlatforms(
  input: CarryForwardCachedPlatformsInput,
): Promise<PayloadPlatform[]> {
  const manifest = await readPayloadManifest(input.hostPayloadDir);
  if (
    !manifest ||
    manifest.version !== input.version ||
    manifest.formatRevision !== PAYLOAD_FORMAT_REVISION
  ) {
    return [];
  }

  const carried: PayloadPlatform[] = [];
  for (const platform of manifest.platforms) {
    if (input.requestedPlatforms.includes(platform)) {
      continue;
    }
    const source = payloadBinaryPath(input.hostPayloadDir, platform);
    if (!(await payloadFileExists(source))) {
      continue;
    }
    const destination = payloadBinaryPath(input.stagingDir, platform);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, 0o755);
    carried.push(platform);
  }
  return carried;
}

/**
 * GC payload versions other than the pinned one. Reused payloads are cached, so
 * on a version bump older directories accumulate; remove them. Staging dirs
 * (prefixed `.staging-`) left by aborted provisions are also swept.
 */
export async function gcStalePayloadVersions(
  cacheRoot: string,
  keepVersion: string,
): Promise<void> {
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
    try {
      await rm(path.join(cacheRoot, entry), { recursive: true, force: true });
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

/** `stat`-based existence probe used across payload cache operations. */
export async function payloadFileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
