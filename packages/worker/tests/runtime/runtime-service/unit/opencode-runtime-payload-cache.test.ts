import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PAYLOAD_FORMAT_REVISION,
  type PayloadPlatform,
} from "../../../../src/runtime/runtime-service/domain/opencode-runtime-payload";
import {
  carryForwardCachedPlatforms,
  gcStalePayloadVersions,
  payloadBinaryPath,
  readPayloadManifest,
  writePayloadManifest,
} from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-cache";

/**
 * The payload cache is SHARED between two callers that want different platform
 * subsets: the worker (full Linux set, mounted into a devcontainer) and the
 * CLI's interactive TUI (host-native only). Without carry-forward, each one's
 * atomic republish would delete the other's binaries and the pair would
 * re-download ~100 MB apiece forever. These tests pin that behaviour.
 */

const VERSION = "1.18.11";

async function writeBinary(
  payloadDir: string,
  platform: PayloadPlatform,
  contents: string,
): Promise<void> {
  const binaryPath = payloadBinaryPath(payloadDir, platform);
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, contents, "utf8");
}

describe("opencode runtime payload cache", () => {
  let root: string;
  let existing: string;
  let staging: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "oc-payload-cache-"));
    existing = path.join(root, VERSION);
    staging = path.join(root, ".staging-x");
    await mkdir(existing, { recursive: true });
    await mkdir(staging, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("carries forward cached platforms the caller did not request", async () => {
    await writeBinary(existing, "linux-x64", "linux-x64-bin");
    await writeBinary(existing, "linux-arm64", "linux-arm64-bin");
    await writeBinary(existing, "darwin-arm64", "old-darwin-bin");
    await writePayloadManifest(existing, VERSION, [
      "linux-x64",
      "linux-arm64",
      "darwin-arm64",
    ]);
    // The CLI just downloaded a fresh darwin-arm64 into staging.
    await writeBinary(staging, "darwin-arm64", "new-darwin-bin");

    const carried = await carryForwardCachedPlatforms({
      hostPayloadDir: existing,
      stagingDir: staging,
      version: VERSION,
      requestedPlatforms: ["darwin-arm64"],
    });

    expect(carried.sort()).toEqual(["linux-arm64", "linux-x64"]);
    expect(
      await readFile(payloadBinaryPath(staging, "linux-x64"), "utf8"),
    ).toBe("linux-x64-bin");
    // The freshly-downloaded binary is NOT clobbered by the cached one.
    expect(
      await readFile(payloadBinaryPath(staging, "darwin-arm64"), "utf8"),
    ).toBe("new-darwin-bin");
  });

  test("carries forward nothing when the cached payload is a different version", async () => {
    await writeBinary(existing, "linux-x64", "old-bin");
    await writePayloadManifest(existing, "1.17.0", ["linux-x64"]);

    expect(
      await carryForwardCachedPlatforms({
        hostPayloadDir: existing,
        stagingDir: staging,
        version: VERSION,
        requestedPlatforms: ["darwin-arm64"],
      }),
    ).toEqual([]);
  });

  test("carries forward nothing when the format revision differs", async () => {
    await writeBinary(existing, "linux-x64", "old-bin");
    await writeFile(
      path.join(existing, "manifest.json"),
      JSON.stringify({
        version: VERSION,
        platforms: ["linux-x64"],
        provisionedAt: new Date().toISOString(),
        formatRevision: PAYLOAD_FORMAT_REVISION + 1,
      }),
      "utf8",
    );

    expect(
      await carryForwardCachedPlatforms({
        hostPayloadDir: existing,
        stagingDir: staging,
        version: VERSION,
        requestedPlatforms: ["darwin-arm64"],
      }),
    ).toEqual([]);
  });

  test("skips manifest platforms whose binary is missing on disk", async () => {
    await writePayloadManifest(existing, VERSION, ["linux-x64"]);

    expect(
      await carryForwardCachedPlatforms({
        hostPayloadDir: existing,
        stagingDir: staging,
        version: VERSION,
        requestedPlatforms: ["darwin-arm64"],
      }),
    ).toEqual([]);
  });

  test("carries forward nothing when there is no existing payload", async () => {
    expect(
      await carryForwardCachedPlatforms({
        hostPayloadDir: path.join(root, "does-not-exist"),
        stagingDir: staging,
        version: VERSION,
        requestedPlatforms: ["darwin-arm64"],
      }),
    ).toEqual([]);
  });

  test("manifest round-trips version, platforms and format revision", async () => {
    await writePayloadManifest(existing, VERSION, ["darwin-arm64"]);

    const manifest = await readPayloadManifest(existing);
    expect(manifest?.version).toBe(VERSION);
    expect(manifest?.platforms).toEqual(["darwin-arm64"]);
    expect(manifest?.formatRevision).toBe(PAYLOAD_FORMAT_REVISION);
  });

  test("GC removes other versions and staging dirs but keeps the pinned one", async () => {
    await mkdir(path.join(root, "1.17.0"), { recursive: true });
    await writePayloadManifest(existing, VERSION, ["darwin-arm64"]);

    await gcStalePayloadVersions(root, VERSION);

    // `.staging-x` and `1.17.0` are swept; the pinned version survives intact.
    expect(await readdir(root)).toEqual([VERSION]);
    expect((await readPayloadManifest(existing))?.version).toBe(VERSION);
  });
});
