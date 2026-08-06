import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logWorkDebug } from "../../../work/step-execution/application/work-logger";
import {
  opencodePlatformPackage,
  type OpencodePayloadProgressListener,
  type PayloadPlatform,
} from "../domain/opencode-runtime-payload";

/**
 * Downloads a single `opencode-<platform>` standalone binary out of the npm
 * registry tarball.
 *
 * Extracted from {@link OpencodeRuntimePayloadProvisioner} so the provisioner
 * stays inside the per-file line limit and so the download can stream (and
 * therefore report byte-level progress) without bloating the provisioner.
 *
 * The tarball is a standard gzipped npm package containing exactly
 * `package/package.json` + `package/bin/opencode`; system `tar` is used to
 * extract because it is universally available on worker hosts.
 */

const execFileAsync = promisify(execFile);

/** Emit at most one progress event per this many bytes, to avoid event storms. */
const PROGRESS_CHUNK_BYTES = 512 * 1024;

export type FetchOpencodePlatformBinaryInput = {
  /** Pinned OpenCode version to fetch. */
  version: string;
  /** Platform key (maps to the `opencode-<platform>` npm package). */
  platform: PayloadPlatform;
  /** npm registry base URL, without a trailing slash. */
  registryBaseUrl: string;
  /** Absolute path the extracted `opencode` binary is written to (0755). */
  destinationPath: string;
  /** Optional progress sink. */
  onProgress?: OpencodePayloadProgressListener | undefined;
};

export type FetchOpencodePlatformBinaryResult = {
  /** Size of the downloaded tarball in bytes. */
  bytes: number;
};

/**
 * Download + extract the standalone binary for one platform into
 * `destinationPath`. Throws on a non-2xx response or a tarball that does not
 * contain `package/bin/opencode`.
 */
export async function fetchOpencodePlatformBinary(
  input: FetchOpencodePlatformBinaryInput,
): Promise<FetchOpencodePlatformBinaryResult> {
  const pkg = opencodePlatformPackage(input.platform);
  const tarballUrl = `${input.registryBaseUrl}/${pkg}/-/${pkg}-${input.version}.tgz`;

  const downloadDir = await mkdtemp(
    path.join(os.tmpdir(), `oc-payload-${input.platform}-`),
  );
  const tarballPath = path.join(downloadDir, "package.tgz");
  const extractDir = path.join(downloadDir, "extract");

  try {
    logWorkDebug("runtime", "Downloading OpenCode platform binary", {
      version: input.version,
      platform: input.platform,
      tarballUrl,
    });

    const bytes = await downloadTarball(tarballUrl, tarballPath, input);

    await mkdir(extractDir, { recursive: true });
    await execFileAsync("tar", [
      "-xzf",
      tarballPath,
      "-C",
      extractDir,
      "package/bin/opencode",
    ]);

    const extractedBinary = path.join(extractDir, "package", "bin", "opencode");
    if (!(await fileExists(extractedBinary))) {
      throw new Error(
        `Extracted ${pkg}@${input.version} but bin/opencode was not present`,
      );
    }

    await mkdir(path.dirname(input.destinationPath), { recursive: true });
    const contents = await readFile(extractedBinary);
    await writeFile(input.destinationPath, contents);
    await chmod(input.destinationPath, 0o755);

    return { bytes };
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

/**
 * Stream the tarball to disk, emitting throttled progress events. Falls back to
 * a buffered read when the response exposes no body stream.
 */
async function downloadTarball(
  tarballUrl: string,
  tarballPath: string,
  input: FetchOpencodePlatformBinaryInput,
): Promise<number> {
  const pkg = opencodePlatformPackage(input.platform);
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${pkg}@${input.version} (${tarballUrl}): ` +
        `HTTP ${String(response.status)}`,
    );
  }

  const totalBytes = parseContentLength(response.headers.get("content-length"));
  const body = response.body;

  if (body === null) {
    const buffered = new Uint8Array(await response.arrayBuffer());
    await writeFile(tarballPath, buffered);
    return buffered.byteLength;
  }

  const handle = await open(tarballPath, "w");
  let received = 0;
  let lastReported = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      await handle.write(chunk.value);
      received += chunk.value.byteLength;
      if (received - lastReported >= PROGRESS_CHUNK_BYTES) {
        lastReported = received;
        input.onProgress?.({
          phase: "platform-progress",
          version: input.version,
          platform: input.platform,
          receivedBytes: received,
          totalBytes,
        });
      }
    }
  } finally {
    await handle.close();
  }
  return received;
}

function parseContentLength(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
