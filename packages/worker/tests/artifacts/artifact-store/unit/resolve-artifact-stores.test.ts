import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CompositeArtifactStore } from "../../../../src/artifacts/artifact-store/infra/composite-artifact-store";
import { resolveArtifactStores } from "../../../../src/artifacts/artifact-store/infra/resolve-artifact-stores";
import type { RemoteArtifactUploader } from "../../../../src/work/step-execution/contracts/process-project-work-types";

const stubRemoteUploader: RemoteArtifactUploader = {
  createArtifactUploadUrl: () =>
    Promise.resolve({
      uploadUrl: "https://example.test/upload",
      storeRef: "remote://artifact",
      objectKey: "key",
      expiresInSeconds: 60,
    }),
  recordArtifact: () => Promise.resolve(),
};

describe("resolveArtifactStores", () => {
  let localDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    localDir = await mkdtemp(path.join(os.tmpdir(), "resolve-artifact-local-"));
    sourceFile = path.join(localDir, "source.txt");
    await writeFile(sourceFile, "hello-artifact");
  });

  afterEach(async () => {
    await rm(localDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("local-only selection writes to the local dir", async () => {
    const store = resolveArtifactStores(
      { BOBODDY_ARTIFACT_STORES: "local" },
      { defaultLocalDir: localDir },
    );
    expect(store).toBeInstanceOf(CompositeArtifactStore);

    await store.saveArtifact({
      stepExecutionId: "step-1",
      sourcePath: sourceFile,
      relativeStorePath: "out.txt",
      kind: "generic",
    });
    const stored = await readFile(
      path.join(localDir, "step-1", "out.txt"),
      "utf8",
    );
    expect(stored).toBe("hello-artifact");
  });

  test("uses BOBODDY_ARTIFACT_LOCAL_DIR override for the local store", async () => {
    const overrideDir = await mkdtemp(
      path.join(os.tmpdir(), "resolve-artifact-override-"),
    );
    try {
      const store = resolveArtifactStores({
        BOBODDY_ARTIFACT_STORES: "local",
        BOBODDY_ARTIFACT_LOCAL_DIR: overrideDir,
      });
      await store.saveArtifact({
        stepExecutionId: "step-1",
        sourcePath: sourceFile,
        relativeStorePath: "out.txt",
        kind: "generic",
      });
      const entries = await readdir(path.join(overrideDir, "step-1"));
      expect(entries).toContain("out.txt");
    } finally {
      await rm(overrideDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  });

  test("enables both stores by default when a remote uploader is provided", () => {
    const store = resolveArtifactStores(
      {},
      { defaultLocalDir: localDir, remoteUploader: stubRemoteUploader },
    );
    expect(store).toBeInstanceOf(CompositeArtifactStore);
  });

  test("throws when 'remote' is requested but no uploader is provided", () => {
    expect(() =>
      resolveArtifactStores(
        { BOBODDY_ARTIFACT_STORES: "local,remote" },
        { defaultLocalDir: localDir },
      ),
    ).toThrow(/no remote uploader/i);
  });

  test("throws on unknown store name", () => {
    expect(() =>
      resolveArtifactStores(
        { BOBODDY_ARTIFACT_STORES: "local,ftp" },
        { defaultLocalDir: localDir, remoteUploader: stubRemoteUploader },
      ),
    ).toThrow(/Unknown artifact store 'ftp'/);
  });

  test("throws when selection resolves to no stores", () => {
    expect(() =>
      resolveArtifactStores(
        { BOBODDY_ARTIFACT_STORES: " , " },
        { defaultLocalDir: localDir, remoteUploader: stubRemoteUploader },
      ),
    ).toThrow(/No artifact stores are enabled/);
  });
});
